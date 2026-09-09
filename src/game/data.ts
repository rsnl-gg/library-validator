import { readdir } from "node:fs/promises";
import path from "node:path";
import { readExact, readPrefix } from "../core/io.js";
import { parseArchive, parsePatchName, readArchiveTocSize, type ArchiveAsset } from "../stingray/archive.js";
import { DsarReader, isDsarMagic } from "../stingray/dsar.js";
import { readUnitVersion, UNIT_TYPE_ID, UNIT_VERSION_BYTES, unitAssets } from "../stingray/unit.js";
import { isSlimGameDir, SlimSession } from "./slim.js";

/** Unit versions found in game data, keyed by FileID, plus any unit version seen. */
export interface GameUnitVersions {
  /** FileID to version map as `Map<string, number>`. */
  byFileId: Map<string, number>;
  /** First unit version seen as `number`, or `null` if none. */
  anyVersion: number | null;
}

/** Open Helldivers 2 data folder: slim `bundles.nxa` layout or loose archive files. */
export class GameData {
  private constructor(
    /** Absolute path of the opened game data directory as `string`. */
    readonly gameDir: string,
    private readonly slim: SlimSession | null,
  ) {}

  /**
   * Opens a game data directory. Uses slim mode if `bundles.nxa` is present.
   * @param gameDir - Path to the data folder as `string`.
   * @returns Promise resolving to `GameData`.
   */
  static async open(gameDir: string): Promise<GameData> {
    const dir = path.resolve(gameDir);
    return new GameData(dir, isSlimGameDir(dir) ? await SlimSession.open(dir) : null);
  }

  /**
   * Looks up unit format versions for the given FileIDs.
   * @param fileIds - FileIDs to find as `Set<string>`.
   * @param onProgress - Optional progress callback. Receives current index as `number`, total as `number`, and archive name as `string`.
   * @returns Promise resolving to `GameUnitVersions`.
   */
  async findUnitVersions(
    fileIds: Set<string>,
    onProgress?: (current: number, total: number, name: string) => void,
  ): Promise<GameUnitVersions> {
    return this.slim
      ? this.scanSlim(fileIds, onProgress)
      : this.scanLegacy(fileIds);
  }

  /**
   * Closes slim bundle handles if this session used NXA bundles.
   * @returns Promise that resolves to `void`.
   */
  async close(): Promise<void> {
    await this.slim?.close();
  }

  /**
   * Scans reconstructed archives inside slim bundles for unit versions.
   * @param fileIds - FileIDs to find as `Set<string>`.
   * @param onProgress - Optional progress callback. Receives current index as `number`, total as `number`, and archive name as `string`.
   * @returns Promise resolving to `GameUnitVersions`.
   */
  private async scanSlim(
    fileIds: Set<string>,
    onProgress?: (current: number, total: number, name: string) => void,
  ): Promise<GameUnitVersions> {
    const found = new Map<string, number>();
    let anyVersion: number | null = null;
    const take = collector(found, fileIds, (version) => {
      anyVersion ??= version;
    });
    const packages = this.slim!.mainPackages();
    let index = 0;

    for (const pkg of packages) {
      index += 1;
      onProgress?.(index, packages.length, pkg.name);
      if (allFound(fileIds, found)) {
        break;
      }
      try {
        const parsed = await this.slim!.parseToc(pkg);
        if (anyVersion === null) {
          const first = parsed.assets.find(
            (asset) => asset.typeId === UNIT_TYPE_ID && asset.dataSize >= UNIT_VERSION_BYTES,
          );
          if (first) {
            const bytes = await this.slim!.readRange(pkg, first.dataOffset, UNIT_VERSION_BYTES);
            take(first.fileId, readUnitVersion(bytes));
          }
        }
        for (const asset of unitAssets(parsed.assets, fileIds)) {
          if (found.has(asset.fileId)) {
            continue;
          }
          const bytes = await this.slim!.readRange(pkg, asset.dataOffset, UNIT_VERSION_BYTES);
          take(asset.fileId, readUnitVersion(bytes));
        }
      } catch {
        continue;
      }
    }

    return { byFileId: found, anyVersion };
  }

  /**
   * Scans loose archive files in the game directory.
   * @param fileIds - FileIDs to find as `Set<string>`.
   * @returns Promise resolving to `GameUnitVersions`.
   */
  private async scanLegacy(fileIds: Set<string>): Promise<GameUnitVersions> {
    const found = new Map<string, number>();
    let anyVersion: number | null = null;
    const names = await readdir(this.gameDir);

    for (const name of names) {
      if (allFound(fileIds, found)) {
        break;
      }
      if (parsePatchName(name) || name.endsWith(".stream") || name.endsWith(".gpu_resources")) {
        continue;
      }
      try {
        const versions = await readUnitVersionsFromFile(path.join(this.gameDir, name), fileIds);
        for (const [fileId, version] of versions.byFileId) {
          anyVersion ??= version;
          found.set(fileId, version);
        }
        anyVersion ??= versions.anyVersion;
      } catch {
        continue;
      }
    }

    return { byFileId: found, anyVersion };
  }
}

/**
 * Reports whether every requested FileID has a recorded version.
 * @param fileIds - Requested FileIDs as `Set<string>`.
 * @param found - Recorded versions as `Map<string, number>`.
 * @returns `true` if every id is present, otherwise `false`, as `boolean`.
 */
function allFound(fileIds: Set<string>, found: Map<string, number>): boolean {
  return fileIds.size > 0 && [...fileIds].every((id) => found.has(id));
}

/**
 * Builds a recorder that stores matching FileID versions and notes the first version seen.
 * @param found - Map to fill as `Map<string, number>`.
 * @param fileIds - FileIDs to keep as `Set<string>`.
 * @param noteAny - Callback that receives each version as `number`.
 * @returns A function that records `fileId` as `string` and `version` as `number`.
 */
function collector(
  found: Map<string, number>,
  fileIds: Set<string>,
  noteAny: (version: number) => void,
): (fileId: string, version: number) => void {
  return (fileId, version) => {
    noteAny(version);
    if (fileIds.has(fileId) && !found.has(fileId)) {
      found.set(fileId, version);
    }
  };
}

/**
 * Reads unit versions from one standalone archive.
 * @param filePath - Path to the archive as `string`.
 * @param fileIds - FileIDs to keep as `Set<string>`.
 * @returns Promise resolving to `GameUnitVersions`.
 */
async function readUnitVersionsFromFile(
  filePath: string,
  fileIds: Set<string>,
): Promise<GameUnitVersions> {
  const prefix = await readPrefix(filePath, 12);
  const found = new Map<string, number>();
  let anyVersion: number | null = null;

  const record = async (
    asset: ArchiveAsset,
    read: (offset: number, size: number) => Promise<Uint8Array>,
  ) => {
    const version = readUnitVersion(await read(asset.dataOffset, UNIT_VERSION_BYTES));
    anyVersion ??= version;
    if (fileIds.has(asset.fileId)) {
      found.set(asset.fileId, version);
    }
  };

  if (isDsarMagic(prefix)) {
    const reader = await DsarReader.open(filePath);
    try {
      const tocSize = readArchiveTocSize(await reader.readRange(0, 12));
      const parsed = parseArchive(await reader.readRange(0, tocSize), filePath);
      const first = parsed.assets.find(
        (asset) => asset.typeId === UNIT_TYPE_ID && asset.dataSize >= UNIT_VERSION_BYTES,
      );
      if (first) {
        await record(first, (offset, size) => reader.readRange(offset, size));
      }
      for (const asset of unitAssets(parsed.assets, fileIds)) {
        if (!found.has(asset.fileId)) {
          await record(asset, (offset, size) => reader.readRange(offset, size));
        }
      }
    } finally {
      await reader.close();
    }
    return { byFileId: found, anyVersion };
  }

  if (prefix.length < 12) {
    return { byFileId: found, anyVersion };
  }

  try {
    const tocSize = readArchiveTocSize(prefix);
    const parsed = parseArchive(await readExact(filePath, 0, tocSize), filePath);
    const first = parsed.assets.find(
      (asset) => asset.typeId === UNIT_TYPE_ID && asset.dataSize >= UNIT_VERSION_BYTES,
    );
    if (first) {
      await record(first, (offset, size) => readExact(filePath, offset, size));
    }
    for (const asset of unitAssets(parsed.assets, fileIds)) {
      if (!found.has(asset.fileId)) {
        await record(asset, (offset, size) => readExact(filePath, offset, size));
      }
    }
  } catch {
    return { byFileId: found, anyVersion };
  }

  return { byFileId: found, anyVersion };
}
