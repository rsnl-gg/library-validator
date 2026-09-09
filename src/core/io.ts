import { open } from "node:fs/promises";
import path from "node:path";
import { InvalidFormatError } from "../errors.js";

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
