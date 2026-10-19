import path from "node:path";
import { sliceExact } from "../core/binary.js";
import { fileExists, replaceFile, replaceWithBackup } from "../core/io.js";
import { GameDataError } from "../errors.js";
import type { GameUnitVersions } from "../game/data.js";
import { GameUnitIndex } from "../game/index.js";
import { repairPatchUnits } from "../mod/repair.js";
import { Archive, parseArchive, PatchToc, toPatchBackupPath } from "../stingray/archive.js";
import { readUnitVersion, UNIT_TYPE_ID, UNIT_VERSION_BYTES } from "../stingray/unit.js";

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

/** Options for {@link UnitChecker.open}. */
export interface UnitCheckerOptions {
  /** Optional progress callback while game data is indexed. Receives current index as `number`, total as `number`, and archive name as `string`. */
  onProgress?: (current: number, total: number, name: string) => void;
}

/** Options for {@link UnitChecker.check}. */
export interface UnitCheckOptions {
  /** Same as {@link CheckUnitCompatibilityOptions.repair}. Defaults to false, as `boolean`. */
  repair?: boolean;
}

/**
 * Reusable unit compatibility checker. Game data is indexed once in {@link UnitChecker.open}
 * and every {@link UnitChecker.check} reads only the TOC and unit headers of one patch,
 * so memory does not grow with the number or size of the patches checked.
 * A patch is read in full only when it gets repaired.
 */
export class UnitChecker {
  private constructor(private readonly index: GameUnitIndex) {}

  /** Absolute path of the indexed game data directory as `string`. */
  get gameDataDir(): string {
    return this.index.gameDir;
  }

  /** Identity of the indexed game data as `string`, see {@link UnitChecker.isStale}. */
  get fingerprint(): string {
    return this.index.fingerprint;
  }

  /**
   * Indexes the unit versions of the game data directory.
   * @param gameDataDir - Path to the Helldivers 2 data folder as `string`.
   * @param options - Optional {@link UnitCheckerOptions}.
   * @returns Promise resolving to `UnitChecker`. Call {@link UnitChecker.close} when done.
   */
  static async open(gameDataDir: string, options: UnitCheckerOptions = {}): Promise<UnitChecker> {
    return new UnitChecker(await GameUnitIndex.build(gameDataDir, options.onProgress));
  }

  /**
   * Reports whether game data changed since the checker was opened, for example after a game update.
   * @returns Promise resolving to `boolean`. Unreadable game data counts as changed.
   */
  async isStale(): Promise<boolean> {
    try {
      return (await GameUnitIndex.fingerprintOf(this.index.gameDir)) !== this.index.fingerprint;
    } catch {
      return true;
    }
  }

  /**
   * Compares one patch with the indexed game data, and repairs it when requested,
   * with the same result {@link checkUnitCompatibility} gives for that path.
   * @param patchPath - Path to a `.patch_N` file as `string`.
   * @param options - Optional {@link UnitCheckOptions}.
   * @returns Promise resolving to {@link UnitCompatibility}.
   */
  async check(patchPath: string, options: UnitCheckOptions = {}): Promise<UnitCompatibility> {
    const item = await readPatchUnits(patchPath);
    if (!item.patch) {
      return { compatible: false, reason: "no-unit" };
    }
    return applyCatalog(item.patch, item.units, this.index, Boolean(options.repair));
  }

  /**
   * Closes game file handles.
   * @returns Promise that resolves to `void`.
   */
  async close(): Promise<void> {
    await this.index.close();
  }
}

/** A patch whose units could be read, as kept between reading and comparing. */
interface PatchInfo {
  /** Absolute patch path as `string`. */
  filePath: string;
  /** True when the patch is a compressed DSAR container, as `boolean`. */
  compressed: boolean;
}

/**
 * Reads the unit versions of one patch from its TOC and the first bytes of each unit.
 * Fails the same way as slicing every unit out of the fully read archive: an unreadable
 * patch, a unit outside the archive, or a unit too small for a version gives `patch: null`.
 * @param patchPath - Patch file path as `string`.
 * @returns Promise resolving to the patch info, or `null`, and FileID to version as `Map<string, number>`.
 */
async function readPatchUnits(
  patchPath: string,
): Promise<{ patch: PatchInfo | null; units: Map<string, number> }> {
  let toc: PatchToc;
  try {
    toc = await PatchToc.open(path.resolve(patchPath));
  } catch {
    return { patch: null, units: new Map<string, number>() };
  }

  try {
    const units = new Map<string, number>();
    for (const asset of toc.assets) {
      if (asset.typeId !== UNIT_TYPE_ID || asset.dataSize === 0) {
        continue;
      }
      if (!toc.contains(asset)) {
        return { patch: null, units: new Map<string, number>() };
      }
      units.set(asset.fileId, readUnitVersion(await toc.read(asset, UNIT_VERSION_BYTES)));
    }
    return { patch: { filePath: toc.filePath, compressed: toc.compressed }, units };
  } catch {
    return { patch: null, units: new Map<string, number>() };
  } finally {
    await toc.close();
  }
}

/**
 * Reads each patch's units one at a time, indexes game data once, then compares and optionally repairs each file.
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

  const items: Array<{ patch: PatchInfo | null; units: Map<string, number> }> = [];
  for (const patchPath of patchPaths) {
    items.push(await readPatchUnits(patchPath));
  }

  if (!items.some((item) => item.units.size > 0)) {
    return items.map(() => ({ compatible: false, reason: "no-unit" as const }));
  }

  const repair = Boolean(options.repair);
  const index = await GameUnitIndex.build(gameDataDir, options.onProgress);
  try {
    const results: UnitCompatibility[] = [];
    const total = items.length;
    for (let position = 0; position < items.length; position += 1) {
      const item = items[position];
      const name = item.patch ? path.basename(item.patch.filePath) : "";
      options.onPatchProgress?.(position + 1, total, name);
      if (!item.patch) {
        results.push({ compatible: false, reason: "no-unit" });
        continue;
      }
      results.push(await applyCatalog(item.patch, item.units, index, repair));
    }
    return results;
  } finally {
    await index.close();
  }
}

/**
 * Compares one patch against the game index and publishes a repaired copy when requested.
 * The full patch and the game payloads of its units are only read for a repair.
 * @param patch - Patch info as `PatchInfo`.
 * @param patchUnits - Patch FileID to version map as `Map<string, number>`.
 * @param index - Game unit index as `GameUnitIndex`.
 * @param repair - Whether to publish a repaired `.patch_N` and keep the original as `.backup_N`, as `boolean`.
 * @returns Promise resolving to {@link UnitCompatibility}.
 */
async function applyCatalog(
  patch: PatchInfo,
  patchUnits: Map<string, number>,
  index: GameUnitIndex,
  repair: boolean,
): Promise<UnitCompatibility> {
  if (patchUnits.size === 0) {
    return { compatible: false, reason: "no-unit" };
  }

  await index.loadVersions(patchUnits.keys());
  const catalog = index.catalog();
  const result = compareUnits(patchUnits, catalog);
  if (result.reason !== "version-mismatch" || !repair || patch.compressed) {
    return result;
  }

  const backupPath = toPatchBackupPath(patch.filePath);
  if (await fileExists(backupPath)) {
    return repairFromBackup(patch.filePath, backupPath, index, result);
  }

  let repairedBytes: Uint8Array;
  try {
    const archive = await Archive.open(patch.filePath);
    repairedBytes = repairPatchUnits(archive.bytes, await index.payloads(patchUnits.keys()));
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
 * Repairs a patch that was already repaired once and no longer matches the game, for example
 * after a game update. The original modder file kept as `.backup_N` is repaired again against
 * current game data and replaces `.patch_N`; the backup is never changed. When the backup cannot
 * be used, the patch is left as it is, as before.
 * @param patchPath - Absolute patch path as `string`.
 * @param backupPath - Existing backup path as `string`.
 * @param index - Game unit index as `GameUnitIndex`.
 * @param result - Comparison of the current patch as {@link UnitCompatibility}.
 * @returns Promise resolving to {@link UnitCompatibility} with `repaired: true`.
 */
async function repairFromBackup(
  patchPath: string,
  backupPath: string,
  index: GameUnitIndex,
  result: UnitCompatibility,
): Promise<UnitCompatibility> {
  let repairedBytes: Uint8Array;
  try {
    const original = await readPatchUnits(backupPath);
    if (!original.patch || original.patch.compressed || original.units.size === 0) {
      return { ...result, repaired: true };
    }
    await index.loadVersions(original.units.keys());
    const archive = await Archive.open(backupPath);
    repairedBytes = repairPatchUnits(archive.bytes, await index.payloads(original.units.keys()));
    await replaceFile(patchPath, repairedBytes);
  } catch {
    return { ...result, repaired: true };
  }
  const repaired = parseArchive(repairedBytes, patchPath);
  return {
    ...compareUnits(unitsFromArchive(repaired.assets, repairedBytes), index.catalog()),
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
