import { readdir } from "node:fs/promises";
import path from "node:path";
import { readExact, readPrefix } from "../core/io.js";
import { parseArchive, parseBackupName, parsePatchName, readArchiveTocSize, type ArchiveAsset } from "../stingray/archive.js";
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

/** Unit versions plus optional full payloads used to repair outdated patches. */
export interface GameUnitCatalog extends GameUnitVersions {
  /** FileID to full unit payload map as `Map<string, Uint8Array>`. Empty when payloads were not requested. */
  payloads: Map<string, Uint8Array>;
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
    const catalog = await this.findUnitCatalog(fileIds, onProgress, false);
    return { byFileId: catalog.byFileId, anyVersion: catalog.anyVersion };
  }

  /**
   * Looks up unit versions, and full payloads when `includePayloads` is true.
   * @param fileIds - FileIDs to find as `Set<string>`.
   * @param onProgress - Optional progress callback. Receives current index as `number`, total as `number`, and archive name as `string`.
   * @param includePayloads - When true, stores full unit bytes for matching FileIDs, as `boolean`.
   * @returns Promise resolving to `GameUnitCatalog`.
   */
  async findUnitCatalog(
    fileIds: Set<string>,
    onProgress?: (current: number, total: number, name: string) => void,
    includePayloads = false,
  ): Promise<GameUnitCatalog> {
    return this.slim
      ? this.scanSlim(fileIds, includePayloads, onProgress)
      : this.scanLegacy(fileIds, includePayloads);
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
   * @param includePayloads - When true, stores full unit bytes for matching FileIDs, as `boolean`.
   * @param onProgress - Optional progress callback. Receives current index as `number`, total as `number`, and archive name as `string`.
   * @returns Promise resolving to `GameUnitCatalog`.
   */
  private async scanSlim(
    fileIds: Set<string>,
    includePayloads: boolean,
    onProgress?: (current: number, total: number, name: string) => void,
  ): Promise<GameUnitCatalog> {
    const found = new Map<string, number>();
    const payloads = new Map<string, Uint8Array>();
    let anyVersion: number | null = null;
    const take = collector(found, payloads, fileIds, includePayloads, (version) => {
      anyVersion ??= version;
    });
    const packages = this.slim!.mainPackages();
    let index = 0;

    for (const pkg of packages) {
      index += 1;
      onProgress?.(index, packages.length, pkg.name);
      if (allFound(fileIds, found) && (!includePayloads || allPayloads(fileIds, payloads))) {
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
            take(first.fileId, bytes, false);
          }
        }
        for (const asset of unitAssets(parsed.assets, fileIds)) {
          if (found.has(asset.fileId) && (!includePayloads || payloads.has(asset.fileId))) {
            continue;
          }
          const bytes = await this.slim!.readRange(pkg, asset.dataOffset, payloadSize(asset, includePayloads));
          take(asset.fileId, bytes, includePayloads);
        }
      } catch {
        continue;
      }
    }

    return { byFileId: found, anyVersion, payloads };
  }

  /**
   * Scans loose archive files in the game directory.
   * @param fileIds - FileIDs to find as `Set<string>`.
   * @param includePayloads - When true, stores full unit bytes for matching FileIDs, as `boolean`.
   * @returns Promise resolving to `GameUnitCatalog`.
   */
  private async scanLegacy(fileIds: Set<string>, includePayloads: boolean): Promise<GameUnitCatalog> {
    const found = new Map<string, number>();
    const payloads = new Map<string, Uint8Array>();
    let anyVersion: number | null = null;
    const names = await readdir(this.gameDir);

    for (const name of names) {
      if (allFound(fileIds, found) && (!includePayloads || allPayloads(fileIds, payloads))) {
        break;
      }
      if (
        parsePatchName(name) ||
        parseBackupName(name) ||
        name.endsWith(".stream") ||
        name.endsWith(".gpu_resources")
      ) {
        continue;
      }
      try {
        const catalog = await readUnitsFromFile(path.join(this.gameDir, name), fileIds, includePayloads);
        for (const [fileId, version] of catalog.byFileId) {
          anyVersion ??= version;
          found.set(fileId, version);
        }
        anyVersion ??= catalog.anyVersion;
        for (const [fileId, payload] of catalog.payloads) {
          payloads.set(fileId, payload);
        }
      } catch {
        continue;
      }
    }

    return { byFileId: found, anyVersion, payloads };
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
 * Reports whether every requested FileID has a stored payload.
 * @param fileIds - Requested FileIDs as `Set<string>`.
 * @param payloads - Recorded payloads as `Map<string, Uint8Array>`.
 * @returns `true` if every id is present, otherwise `false`, as `boolean`.
 */
function allPayloads(fileIds: Set<string>, payloads: Map<string, Uint8Array>): boolean {
  return fileIds.size > 0 && [...fileIds].every((id) => payloads.has(id));
}

/**
 * Returns how many bytes to read for a unit asset during a catalog scan.
 * @param asset - TOC asset as `ArchiveAsset`.
 * @param includePayloads - When true, read the full payload, as `boolean`.
 * @returns Byte count as `number`.
 */
function payloadSize(asset: ArchiveAsset, includePayloads: boolean): number {
  return includePayloads ? asset.dataSize : UNIT_VERSION_BYTES;
}

/**
 * Builds a recorder that stores matching FileID versions, optional payloads, and the first version seen.
 * @param found - Version map to fill as `Map<string, number>`.
 * @param payloads - Payload map to fill as `Map<string, Uint8Array>`.
 * @param fileIds - FileIDs to keep as `Set<string>`.
 * @param includePayloads - When true, store full unit bytes, as `boolean`.
 * @param noteAny - Callback that receives each version as `number`.
 * @returns A function that records `fileId` as `string` and `bytes` as `Uint8Array`.
 */
function collector(
  found: Map<string, number>,
  payloads: Map<string, Uint8Array>,
  fileIds: Set<string>,
  includePayloads: boolean,
  noteAny: (version: number) => void,
): (fileId: string, bytes: Uint8Array, storePayload: boolean) => void {
  return (fileId, bytes, storePayload) => {
    const version = readUnitVersion(bytes);
    noteAny(version);
    if (!fileIds.has(fileId)) {
      return;
    }
    if (!found.has(fileId)) {
      found.set(fileId, version);
    }
    if (includePayloads && storePayload && !payloads.has(fileId)) {
      payloads.set(fileId, bytes.slice());
    }
  };
}

/**
 * Reads unit versions, and optional full payloads, from one standalone archive.
 * @param filePath - Path to the archive as `string`.
 * @param fileIds - FileIDs to keep as `Set<string>`.
 * @param includePayloads - When true, stores full unit bytes for matching FileIDs, as `boolean`.
 * @returns Promise resolving to `GameUnitCatalog`.
 */
async function readUnitsFromFile(
  filePath: string,
  fileIds: Set<string>,
  includePayloads: boolean,
): Promise<GameUnitCatalog> {
  const prefix = await readPrefix(filePath, 12);
  const found = new Map<string, number>();
  const payloads = new Map<string, Uint8Array>();
  let anyVersion: number | null = null;

  const record = async (
    asset: ArchiveAsset,
    read: (offset: number, size: number) => Promise<Uint8Array>,
    size: number,
    storePayload: boolean,
  ) => {
    const bytes = await read(asset.dataOffset, size);
    const version = readUnitVersion(bytes);
    anyVersion ??= version;
    if (!fileIds.has(asset.fileId)) {
      return;
    }
    if (!found.has(asset.fileId)) {
      found.set(asset.fileId, version);
    }
    if (includePayloads && storePayload && !payloads.has(asset.fileId)) {
      payloads.set(asset.fileId, bytes.slice());
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
        await record(first, (offset, size) => reader.readRange(offset, size), UNIT_VERSION_BYTES, false);
      }
      for (const asset of unitAssets(parsed.assets, fileIds)) {
        if (!found.has(asset.fileId) || (includePayloads && !payloads.has(asset.fileId))) {
          await record(
            asset,
            (offset, size) => reader.readRange(offset, size),
            payloadSize(asset, includePayloads),
            includePayloads,
          );
        }
      }
    } finally {
      await reader.close();
    }
    return { byFileId: found, anyVersion, payloads };
  }

  if (prefix.length < 12) {
    return { byFileId: found, anyVersion, payloads };
  }

  try {
    const tocSize = readArchiveTocSize(prefix);
    const parsed = parseArchive(await readExact(filePath, 0, tocSize), filePath);
    const first = parsed.assets.find(
      (asset) => asset.typeId === UNIT_TYPE_ID && asset.dataSize >= UNIT_VERSION_BYTES,
    );
    if (first) {
      await record(first, (offset, size) => readExact(filePath, offset, size), UNIT_VERSION_BYTES, false);
    }
    for (const asset of unitAssets(parsed.assets, fileIds)) {
      if (!found.has(asset.fileId) || (includePayloads && !payloads.has(asset.fileId))) {
        await record(
          asset,
          (offset, size) => readExact(filePath, offset, size),
          payloadSize(asset, includePayloads),
          includePayloads,
        );
      }
    }
  } catch {
    return { byFileId: found, anyVersion, payloads };
  }

  return { byFileId: found, anyVersion, payloads };
}
