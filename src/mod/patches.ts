import { readdir, realpath, stat } from "node:fs/promises";
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
 * Real paths already visited are skipped so junction/symlink cycles cannot loop.
 * @param dir - Directory to scan as `string`.
 * @param seen - Resolved directories already visited as `Set<string>`.
 * @returns Promise resolving to `string[]`.
 */
async function walkPatches(dir: string, seen: Set<string> = new Set()): Promise<string[]> {
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    return [];
  }
  if (seen.has(real)) {
    return [];
  }
  seen.add(real);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walkPatches(full, seen)));
    } else if (PATCH_NAME_RE.test(entry.name)) {
      found.push(full);
    }
  }
  return found.sort();
}
