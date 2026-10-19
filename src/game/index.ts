import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  openArchiveRange,
  parseArchive,
  parseBackupName,
  parsePatchName,
  readArchiveTocSize,
  type ArchiveAsset,
} from "../stingray/archive.js";
import type { BundlePackage } from "../stingray/dsaa.js";
import { readUnitVersion, UNIT_TYPE_ID, UNIT_VERSION_BYTES } from "../stingray/unit.js";
import type { GameUnitCatalog } from "./data.js";
import { isSlimGameDir, SlimSession } from "./slim.js";

/** Where the first copy of a game unit lives: a slim package or a loose archive file. */
type UnitSource =
  | { pkg: BundlePackage; offset: number; size: number }
  | { file: string; offset: number; size: number };

/**
 * Unit versions of the whole game, read once and reused for any number of patches.
 * Only locations and versions are kept in memory; full unit payloads are read on demand for repairs.
 * The first copy of each FileID wins, in the same order {@link GameData} scans game data.
 */
export class GameUnitIndex {
  private constructor(
    /** Absolute path of the indexed game data directory as `string`. */
    readonly gameDir: string,
    /** Value of {@link GameUnitIndex.fingerprintOf} when the index was built, as `string`. */
    readonly fingerprint: string,
    /** FileID to unit format version, filled by {@link GameUnitIndex.loadVersions}, as `Map<string, number>`. */
    readonly versions: Map<string, number>,
    /** Version of the first unit found in game data as `number`, or `null` if none. */
    readonly anyVersion: number | null,
    private readonly sources: Map<string, UnitSource>,
    private readonly slim: SlimSession | null,
  ) {}

  /**
   * Cheap identity of the installed game data, to tell when an index is stale after a game update.
   * @param gameDir - Path to the data folder as `string`.
   * @returns Promise resolving to the fingerprint as `string`.
   */
  static async fingerprintOf(gameDir: string): Promise<string> {
    const dir = path.resolve(gameDir);
    if (isSlimGameDir(dir)) {
      const info = await stat(path.join(dir, "bundles.nxa"));
      return `slim:${info.size}:${info.mtimeMs}`;
    }
    const info = await stat(dir);
    return `legacy:${info.mtimeMs}`;
  }

  /**
   * Reads every unit TOC entry of the game data. Versions are read on demand, see {@link GameUnitIndex.loadVersions}.
   * Uses slim mode if `bundles.nxa` is present, otherwise loose archive files.
   * @param gameDir - Path to the data folder as `string`.
   * @param onProgress - Optional progress callback. Receives current index as `number`, total as `number`, and archive name as `string`.
   * @returns Promise resolving to `GameUnitIndex`. Call {@link GameUnitIndex.close} when done.
   */
  static async build(
    gameDir: string,
    onProgress?: (current: number, total: number, name: string) => void,
  ): Promise<GameUnitIndex> {
    const dir = path.resolve(gameDir);
    const fingerprint = await GameUnitIndex.fingerprintOf(dir);
    if (!isSlimGameDir(dir)) {
      return GameUnitIndex.buildLegacy(dir, fingerprint);
    }

    const slim = await SlimSession.open(dir);
    try {
      const sources = new Map<string, UnitSource>();
      const versions = new Map<string, number>();
      let anyVersion: number | null = null;
      const packages = slim.mainPackages();
      for (let index = 0; index < packages.length; index += 1) {
        const pkg = packages[index];
        onProgress?.(index + 1, packages.length, pkg.name);
        try {
          const parsed = await slim.parseToc(pkg);
          const units = indexableUnits(parsed.assets);
          if (anyVersion === null && units.length > 0) {
            anyVersion = readUnitVersion(await slim.readRange(pkg, units[0].dataOffset, UNIT_VERSION_BYTES));
          }
          for (const asset of units) {
            if (!sources.has(asset.fileId)) {
              sources.set(asset.fileId, { pkg, offset: asset.dataOffset, size: asset.dataSize });
            }
          }
        } catch {
          continue;
        }
      }
      // Bundle handles are reopened on demand, so game files are not held open between checks
      await slim.close();
      return new GameUnitIndex(dir, fingerprint, versions, anyVersion, sources, slim);
    } catch (error) {
      await slim.close();
      throw error;
    }
  }

  /**
   * Indexes loose archive files in the game directory, skipping patches, backups and companion files.
   * @param dir - Absolute game data directory as `string`.
   * @param fingerprint - Fingerprint taken before reading as `string`.
   * @returns Promise resolving to `GameUnitIndex`.
   */
  private static async buildLegacy(dir: string, fingerprint: string): Promise<GameUnitIndex> {
    const sources = new Map<string, UnitSource>();
    const versions = new Map<string, number>();
    let anyVersion: number | null = null;

    for (const name of await readdir(dir)) {
      if (
        parsePatchName(name) ||
        parseBackupName(name) ||
        name.endsWith(".stream") ||
        name.endsWith(".gpu_resources")
      ) {
        continue;
      }
      const file = path.join(dir, name);
      let opened: Awaited<ReturnType<typeof openArchiveRange>>;
      try {
        opened = await openArchiveRange(file);
      } catch {
        continue;
      }
      const { reader } = opened;
      try {
        if (reader.length < 12) {
          continue;
        }
        const parsed = parseArchive(await reader.read(0, readArchiveTocSize(await reader.read(0, 12))), file);
        const units = indexableUnits(parsed.assets);
        if (anyVersion === null && units.length > 0) {
          anyVersion = readUnitVersion(await reader.read(units[0].dataOffset, UNIT_VERSION_BYTES));
        }
        for (const asset of units) {
          if (!sources.has(asset.fileId)) {
            sources.set(asset.fileId, { file, offset: asset.dataOffset, size: asset.dataSize });
          }
        }
      } catch {
        continue;
      } finally {
        await reader.close();
      }
    }

    return new GameUnitIndex(dir, fingerprint, versions, anyVersion, sources, null);
  }

  /**
   * Reads the versions of the given units into {@link GameUnitIndex.versions}, once per FileID.
   * A unit whose version cannot be read is treated as missing from the game.
   * @param fileIds - FileIDs to look up as `Iterable<string>`.
   * @returns Promise that resolves to `void`.
   */
  async loadVersions(fileIds: Iterable<string>): Promise<void> {
    try {
      for (const fileId of fileIds) {
        const source = this.sources.get(fileId);
        if (!source || this.versions.has(fileId)) {
          continue;
        }
        try {
          this.versions.set(fileId, readUnitVersion(await this.readSource(source, UNIT_VERSION_BYTES)));
        } catch {
          this.sources.delete(fileId);
        }
      }
    } finally {
      await this.release();
    }
  }

  /**
   * Reads full game unit payloads, as needed by {@link repairPatchUnits}.
   * @param fileIds - FileIDs to read as `Iterable<string>`. Ids missing from the game are left out.
   * @returns Promise resolving to FileID to payload as `Map<string, Uint8Array>`.
   */
  async payloads(fileIds: Iterable<string>): Promise<Map<string, Uint8Array>> {
    const payloads = new Map<string, Uint8Array>();
    try {
      for (const fileId of fileIds) {
        const source = this.sources.get(fileId);
        if (!source || payloads.has(fileId)) {
          continue;
        }
        payloads.set(fileId, await this.readSource(source));
      }
    } finally {
      await this.release();
    }
    return payloads;
  }

  /**
   * Returns the index as the catalog shape used by unit comparison and repair.
   * @param payloads - Payloads to attach as `Map<string, Uint8Array>`. Defaults to none.
   * @returns Catalog as `GameUnitCatalog`.
   */
  catalog(payloads = new Map<string, Uint8Array>()): GameUnitCatalog {
    return { byFileId: this.versions, anyVersion: this.anyVersion, payloads };
  }

  /**
   * Closes game file handles opened by payload reads. The index stays usable.
   * @returns Promise that resolves to `void`.
   */
  async release(): Promise<void> {
    await this.slim?.close();
  }

  /**
   * Closes every game file handle.
   * @returns Promise that resolves to `void`.
   */
  async close(): Promise<void> {
    await this.release();
  }

  /**
   * Reads a unit payload, or its first bytes, from its source.
   * @param source - Unit location as `UnitSource`.
   * @param size - Bytes to read from the payload start as `number`. Defaults to the whole payload.
   * @returns Promise resolving to the bytes as `Uint8Array`.
   */
  private async readSource(source: UnitSource, size = source.size): Promise<Uint8Array> {
    if ("pkg" in source) {
      return this.slim!.readRange(source.pkg, source.offset, size);
    }
    const { reader } = await openArchiveRange(source.file);
    try {
      return await reader.read(source.offset, size);
    } finally {
      await reader.close();
    }
  }
}

/**
 * Unit TOC entries large enough to hold a version, as the game catalog scans select them.
 * @param assets - Archive TOC assets as `readonly ArchiveAsset[]`.
 * @returns Matching units as `ArchiveAsset[]`.
 */
function indexableUnits(assets: readonly ArchiveAsset[]): ArchiveAsset[] {
  return assets.filter((asset) => asset.typeId === UNIT_TYPE_ID && asset.dataSize >= UNIT_VERSION_BYTES);
}
