import { writeFile } from "node:fs/promises";
import path from "node:path";
import { collectPatchPaths } from "../mod/patches.js";
import { Archive } from "../stingray/archive.js";
import { LUA_TYPE_ID, readLuaSource } from "../stingray/lua.js";

/** Result of scanning a patch or mod folder for Lua script assets. */
export interface LuaScriptResult {
  /** True if at least one Lua asset was found, as `boolean`. */
  found: boolean;
  /** Absolute paths of `.lua` files written when extract is true, as `string[]`. Empty otherwise. */
  extractedPaths: string[];
}

/**
 * Detects Lua script assets in a patch file or a mod directory.
 * When extract is true, each script is written next to its patch as a `.lua` file named after the FileID.
 * @param modPath - Path to a `.patch_N` file or a folder that contains patches, as `string`.
 * @param extract - When true, writes Lua source files to disk. Defaults to false, as `boolean`.
 * @returns Promise resolving to {@link LuaScriptResult}.
 */
export async function hasLuaScript(modPath: string, extract = false): Promise<LuaScriptResult> {
  const extractedPaths: string[] = [];
  let found = false;

  for (const patchPath of await collectPatchPaths(path.resolve(modPath))) {
    const patch = await Archive.open(patchPath);
    const outDir = path.dirname(patchPath);

    for (const asset of patch.assetsOf(LUA_TYPE_ID)) {
      found = true;
      if (!extract) {
        return { found, extractedPaths };
      }
      const extractedPath = path.join(outDir, `${asset.fileId}.lua`);
      await writeFile(extractedPath, readLuaSource(patch.read(asset)));
      extractedPaths.push(extractedPath);
    }
  }

  return { found, extractedPaths };
}
