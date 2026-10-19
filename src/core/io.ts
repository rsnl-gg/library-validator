import { access, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { GenericError, InvalidFormatError } from "../errors.js";

/**
 * Reads up to the requested number of bytes from the start of a file.
 * @param filePath - File to read as `string`.
 * @param size - Maximum number of bytes as `number`.
 * @returns Promise resolving to `Uint8Array`, possibly shorter than size at EOF.
 */
export async function readPrefix(filePath: string, size: number): Promise<Uint8Array> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Reads an exact number of bytes at an offset. Throws {@link InvalidFormatError} if the file is truncated.
 * @param filePath - File to read as `string`.
 * @param offset - Start offset in bytes as `number`.
 * @param size - Exact number of bytes required as `number`.
 * @returns Promise resolving to `Uint8Array` of length size.
 */
export async function readExact(filePath: string, offset: number, size: number): Promise<Uint8Array> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, offset);
    if (bytesRead !== size) {
      throw new InvalidFormatError(`truncated read in ${path.basename(filePath)}`);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Random-access reader over one open file. */
export interface RangeReader {
  /** Readable length in bytes as `number`. */
  readonly length: number;
  /**
   * Reads an exact byte range. Throws {@link InvalidFormatError} if the range is out of bounds.
   * @param offset - Start offset in bytes as `number`.
   * @param size - Exact number of bytes as `number`.
   * @returns Promise resolving to `Uint8Array` of length size.
   */
  read(offset: number, size: number): Promise<Uint8Array>;
  /**
   * Closes the underlying handle.
   * @returns Promise that resolves to `void`.
   */
  close(): Promise<void>;
}

/**
 * Opens a file once for many ranged reads, instead of one open per read.
 * @param filePath - File to read as `string`.
 * @returns Promise resolving to {@link RangeReader}.
 */
export async function openFileRange(filePath: string): Promise<RangeReader> {
  const handle = await open(filePath, "r");
  try {
    const { size: length } = await handle.stat();
    return {
      length,
      async read(offset: number, size: number): Promise<Uint8Array> {
        if (offset < 0 || size < 0 || offset + size > length) {
          throw new InvalidFormatError(
            `${path.basename(filePath)}: range ${offset}+${size} exceeds file of ${length} bytes`,
          );
        }
        const buffer = Buffer.alloc(size);
        if (size === 0) {
          return buffer;
        }
        const { bytesRead } = await handle.read(buffer, 0, size, offset);
        if (bytesRead !== size) {
          throw new InvalidFormatError(`truncated read in ${path.basename(filePath)}`);
        }
        return buffer;
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Renames `filePath` to `backupPath`, then writes `bytes` to `filePath`.
 * If the write fails, the original file is restored to `filePath`.
 * @param filePath - Path of the live file as `string`.
 * @param backupPath - Path to keep the original file as `string`.
 * @param bytes - Replacement contents as `Uint8Array`.
 * @param write - Optional writer used by tests. Receives `filePath` as `string` and `bytes` as `Uint8Array`.
 * @returns Promise that resolves to `void`.
 */
export async function replaceWithBackup(
  filePath: string,
  backupPath: string,
  bytes: Uint8Array,
  write: (target: string, data: Uint8Array) => Promise<void> = defaultWrite,
): Promise<void> {
  if (await fileExists(backupPath)) {
    throw new GenericError(`backup already exists: ${path.basename(backupPath)}`);
  }
  await rename(filePath, backupPath);
  try {
    await write(filePath, bytes);
  } catch (error) {
    await rm(filePath, { force: true });
    await rename(backupPath, filePath);
    throw error;
  }
}

/**
 * Replaces a file through a temporary sibling, so a failed write never leaves it half written.
 * @param filePath - Path of the file to replace as `string`.
 * @param bytes - New contents as `Uint8Array`.
 * @returns Promise that resolves to `void`.
 */
export async function replaceFile(filePath: string, bytes: Uint8Array): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  try {
    await writeFile(tempPath, bytes);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * Reports whether a path exists.
 * @param filePath - Path to test as `string`.
 * @returns Promise resolving to `boolean`.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes bytes to a file, replacing it if it already exists.
 * @param target - Destination path as `string`.
 * @param data - Contents as `Uint8Array`.
 * @returns Promise that resolves to `void`.
 */
async function defaultWrite(target: string, data: Uint8Array): Promise<void> {
  await writeFile(target, data);
}
