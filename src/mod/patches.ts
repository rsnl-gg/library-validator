import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { PATCH_NAME_RE } from "../stingray/archive.js";

/**
 * Collects main patch file paths from a single file or a directory tree.
 * Companion files ending in `.stream` or `.gpu_resources` are skipped.
 * @param inputPath - File path or directory path as `string`.
 * @returns Promise resolving to `string[]` of `.patch_N` paths, possibly empty.
 */
export async function collectPatchPaths(inputPath: string): Promise<string[]> {
  const info = await stat(inputPath);
  if (info.isFile()) {
    return PATCH_NAME_RE.test(path.basename(inputPath)) ? [inputPath] : [];
  }

  if (!info.isDirectory()) {
    return [];
  }

  return walkPatches(inputPath);
}

/**
 * Walks a directory tree recursively and returns sorted patch paths.
 * @param dir - Directory to scan as `string`.
 * @returns Promise resolving to `string[]`.
 */
async function walkPatches(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walkPatches(full)));
    } else if (PATCH_NAME_RE.test(entry.name)) {
      found.push(full);
    }
  }
  return found.sort();
}
