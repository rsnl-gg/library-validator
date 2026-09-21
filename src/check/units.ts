import path from "node:path";
import { sliceExact } from "../core/binary.js";
import { fileExists, replaceWithBackup } from "../core/io.js";
import { GameDataError } from "../errors.js";
import { GameData, type GameUnitCatalog, type GameUnitVersions } from "../game/data.js";
import { repairPatchUnits } from "../mod/repair.js";
import { Archive, parseArchive, toPatchBackupPath } from "../stingray/archive.js";
import { readUnitVersion, UNIT_TYPE_ID } from "../stingray/unit.js";

/** Incompatibility cause: `"no-unit"` or `"version-mismatch"`. */
export type UnitCompatibilityReason = "no-unit" | "version-mismatch";

/** Options for {@link checkUnitCompatibility}. */
export interface CheckUnitCompatibilityOptions {
  /** Optional progress callback. Receives current index as `number`, total as `number`, and archive name as `string`. */
  onProgress?: (current: number, total: number, name: string) => void;
  /**
   * When true, a `"version-mismatch"` result is repaired by renaming the original
   * `.patch_N` file to `.backup_N` and writing a new `.patch_N` from current game unit data.
   * Defaults to false, as `boolean`.
   */
  repair?: boolean;
  /**
   * Called once per input patch after game data is loaded, before that patch is compared
   * or repaired. Receives 1-based current index as `number`, total patches as `number`,
   * and the patch basename as `string`.
   */
  onPatchProgress?: (current: number, total: number, name: string) => void;
}

/** Result of comparing unit format versions between a patch and game data. */
export interface UnitCompatibility {
  /** True when every compared unit version matches the game, as `boolean`. */
  compatible: boolean;
  /** Incompatibility cause as `UnitCompatibilityReason`. Set only when compatible is false. */
  reason?: UnitCompatibilityReason;
  /** Unit format version from the patch as `number`. Omitted when reason is `"no-unit"`. */
  patchVersion?: number;
  /** Unit format version from game data as `number`. Omitted when reason is `"no-unit"`. */
  archiveVersion?: number;
  /** True when the original patch was renamed to `.backup_N` and a repaired `.patch_N` was written, as `boolean`. */
  repaired?: boolean;
}

export async function checkUnitCompatibility(
  patchPath: string,
  gameDataDir: string,
  onProgress?: (current: number, total: number, name: string) => void,
): Promise<UnitCompatibility>;
export async function checkUnitCompatibility(
  patchPath: string,
  gameDataDir: string,
  options?: CheckUnitCompatibilityOptions,
): Promise<UnitCompatibility>;
export async function checkUnitCompatibility(
  patchPaths: string[],
  gameDataDir: string,
  onProgress?: (current: number, total: number, name: string) => void,
): Promise<UnitCompatibility[]>;
export async function checkUnitCompatibility(
  patchPaths: string[],
  gameDataDir: string,
  options?: CheckUnitCompatibilityOptions,
): Promise<UnitCompatibility[]>;
/**
 * Compares unit format versions in one or more patches against the game data directory.
 * Game data is opened once for the whole call. When `repair` is true, each
 * `"version-mismatch"` patch is renamed to `.backup_N` and a repaired `.patch_N` is written.
 * If that write fails, the original file is restored to `.patch_N`.
 * @param patchPath - Path to a `.patch_N` file as `string`, or an array of those paths as `string[]`.
 * @param gameDataDir - Path to the Helldivers 2 data folder as `string`.
 * @param onProgressOrOptions - Optional progress callback, or {@link CheckUnitCompatibilityOptions}.
 * @returns Promise resolving to {@link UnitCompatibility} for a single path, or `UnitCompatibility[]` in input order for an array.
 */
export async function checkUnitCompatibility(
  patchPath: string | string[],
  gameDataDir: string,
  onProgressOrOptions?:
    | ((current: number, total: number, name: string) => void)
    | CheckUnitCompatibilityOptions,
): Promise<UnitCompatibility | UnitCompatibility[]> {
  const options = resolveOptions(onProgressOrOptions);
  const batched = Array.isArray(patchPath);
  const results = await checkPatchList(batched ? patchPath : [patchPath], gameDataDir, options);
  return batched ? results : results[0];
}

/**
 * Opens every patch, scans game data once, then compares and optionally repairs each file.
 * @param patchPaths - Patch file paths as `string[]`.
 * @param gameDataDir - Path to the Helldivers 2 data folder as `string`.
 * @param options - Check options as {@link CheckUnitCompatibilityOptions}.
 * @returns Promise resolving to `UnitCompatibility[]` in the same order as `patchPaths`.
 */
async function checkPatchList(
  patchPaths: string[],
  gameDataDir: string,
  options: CheckUnitCompatibilityOptions,
): Promise<UnitCompatibility[]> {
  if (patchPaths.length === 0) {
    return [];
  }

  const opened = await Promise.all(
    patchPaths.map(async (patchPath) => {
      try {
        const patch = await Archive.open(path.resolve(patchPath));
        return { patch, units: unitsFromArchive(patch.assets, patch.bytes) };
      } catch {
        return { patch: null, units: new Map<string, number>() };
      }
    }),
  );

  const fileIds = new Set<string>();
  for (const item of opened) {
    for (const fileId of item.units.keys()) {
      fileIds.add(fileId);
    }
  }

  if (fileIds.size === 0) {
    return opened.map(() => ({ compatible: false, reason: "no-unit" as const }));
  }

  const repair = Boolean(options.repair);
  const needPayloads =
    repair && opened.some((item) => item.patch && item.units.size > 0 && !item.patch.compressed);
  const game = await GameData.open(gameDataDir);
  try {
    const catalog = await game.findUnitCatalog(fileIds, options.onProgress, needPayloads);
    const results: UnitCompatibility[] = [];
    const total = opened.length;
    for (let index = 0; index < opened.length; index += 1) {
      const item = opened[index];
      const name = item.patch ? path.basename(item.patch.filePath) : "";
      options.onPatchProgress?.(index + 1, total, name);
      if (!item.patch) {
        results.push({ compatible: false, reason: "no-unit" });
        continue;
      }
      results.push(await applyCatalog(item.patch, item.units, catalog, repair));
    }
    return results;
  } finally {
    await game.close();
  }
}

/**
 * Compares one opened patch against a shared game catalog and publishes a repaired copy when requested.
 * @param patch - Opened patch as `Archive`.
 * @param patchUnits - Patch FileID to version map as `Map<string, number>`.
 * @param catalog - Shared game unit catalog as `GameUnitCatalog`.
 * @param repair - Whether to publish a repaired `.patch_N` and keep the original as `.backup_N`, as `boolean`.
 * @returns Promise resolving to {@link UnitCompatibility}.
 */
async function applyCatalog(
  patch: Archive,
  patchUnits: Map<string, number>,
  catalog: GameUnitCatalog,
  repair: boolean,
): Promise<UnitCompatibility> {
  if (patchUnits.size === 0) {
    return { compatible: false, reason: "no-unit" };
  }

  const result = compareUnits(patchUnits, catalog);
  if (result.reason !== "version-mismatch" || !repair || patch.compressed) {
    return result;
  }

  const backupPath = toPatchBackupPath(patch.filePath);
  if (await fileExists(backupPath)) {
    return { ...result, repaired: true };
  }

  let repairedBytes: Uint8Array;
  try {
    repairedBytes = repairPatchUnits(patch.bytes, catalog.payloads);
    await replaceWithBackup(patch.filePath, backupPath, repairedBytes);
  } catch {
    return result;
  }
  const repaired = parseArchive(repairedBytes, patch.filePath);
  return {
    ...compareUnits(unitsFromArchive(repaired.assets, repairedBytes), catalog),
    repaired: true,
  };
}

/**
 * Normalizes the third argument of {@link checkUnitCompatibility} into options.
 * @param onProgressOrOptions - Progress callback or options object.
 * @returns Options as {@link CheckUnitCompatibilityOptions}.
 */
function resolveOptions(
  onProgressOrOptions?:
    | ((current: number, total: number, name: string) => void)
    | CheckUnitCompatibilityOptions,
): CheckUnitCompatibilityOptions {
  if (typeof onProgressOrOptions === "function") {
    return { onProgress: onProgressOrOptions };
  }
  return onProgressOrOptions ?? {};
}

/**
 * Reads unit format versions from TOC assets that have a unit payload.
 * @param assets - Archive assets as `readonly { fileId: string; typeId: string; dataOffset: number; dataSize: number }[]`.
 * @param data - Archive bytes as `Uint8Array`.
 * @returns FileID to version map as `Map<string, number>`.
 */
function unitsFromArchive(
  assets: readonly { fileId: string; typeId: string; dataOffset: number; dataSize: number }[],
  data: Uint8Array,
): Map<string, number> {
  const patchUnits = new Map<string, number>();
  for (const asset of assets) {
    if (asset.typeId !== UNIT_TYPE_ID || asset.dataSize === 0) {
      continue;
    }
    patchUnits.set(
      asset.fileId,
      readUnitVersion(sliceExact(data, asset.dataOffset, asset.dataSize, `${asset.fileId} data`)),
    );
  }
  return patchUnits;
}

/**
 * Compares patch unit versions against game catalog versions.
 * @param patchUnits - Patch FileID to version map as `Map<string, number>`.
 * @param versions - Game versions as `GameUnitVersions`.
 * @returns Comparison as {@link UnitCompatibility}.
 */
function compareUnits(patchUnits: Map<string, number>, versions: GameUnitVersions): UnitCompatibility {
  if (patchUnits.size === 0) {
    return { compatible: false, reason: "no-unit" };
  }

  const pairs: Array<{ patchVersion: number; archiveVersion: number }> = [];
  for (const [fileId, patchVersion] of patchUnits) {
    const archiveVersion = versions.byFileId.get(fileId);
    if (archiveVersion !== undefined) {
      pairs.push({ patchVersion, archiveVersion });
    }
  }

  if (pairs.length === 0) {
    if (versions.anyVersion === null) {
      throw new GameDataError("no unit files found in game data");
    }
    pairs.push({
      patchVersion: [...patchUnits.values()][0],
      archiveVersion: versions.anyVersion,
    });
  }

  const compatible = pairs.every((pair) => pair.patchVersion === pair.archiveVersion);
  return {
    compatible,
    reason: compatible ? undefined : "version-mismatch",
    patchVersion: pairs[0].patchVersion,
    archiveVersion: pairs[0].archiveVersion,
  };
}
