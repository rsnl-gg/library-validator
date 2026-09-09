import path from "node:path";
import { GameDataError } from "../errors.js";
import { GameData } from "../game/data.js";
import { Archive } from "../stingray/archive.js";
import { readUnitVersion, UNIT_TYPE_ID } from "../stingray/unit.js";

/** Incompatibility cause: `"no-unit"` or `"version-mismatch"`. */
export type UnitCompatibilityReason = "no-unit" | "version-mismatch";

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
}

/**
 * Compares unit format versions in a patch against the game data directory.
 * @param patchPath - Path to a `.patch_N` file as `string`.
 * @param gameDataDir - Path to the Helldivers 2 data folder as `string`.
 * @param onProgress - Optional progress callback. Receives current index as `number`, total as `number`, and archive name as `string`.
 * @returns Promise resolving to {@link UnitCompatibility}.
 */
export async function checkUnitCompatibility(
  patchPath: string,
  gameDataDir: string,
  onProgress?: (current: number, total: number, name: string) => void,
): Promise<UnitCompatibility> {
  const patch = await Archive.open(path.resolve(patchPath));
  const patchUnits = new Map<string, number>();

  for (const asset of patch.assetsOf(UNIT_TYPE_ID)) {
    patchUnits.set(asset.fileId, readUnitVersion(patch.read(asset)));
  }

  if (patchUnits.size === 0) {
    return { compatible: false, reason: "no-unit" };
  }

  const game = await GameData.open(gameDataDir);
  try {
    const versions = await game.findUnitVersions(new Set(patchUnits.keys()), onProgress);

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
  } finally {
    await game.close();
  }
}
