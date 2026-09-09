import { decompressBlock } from "lz4-lite";
import { InvalidFormatError } from "../errors.js";

/**
 * Decompresses a raw LZ4 block to a buffer of the expected length.
 * @param src - Compressed block as `Uint8Array`.
 * @param uncompressedSize - Expected output length as `number`.
 * @returns Decompressed `Uint8Array` of length uncompressedSize.
 */
export function lz4DecompressBlock(src: Uint8Array, uncompressedSize: number): Uint8Array {
  const out = decompressBlock(src, uncompressedSize);
  if (out.byteLength !== uncompressedSize) {
    throw new InvalidFormatError(
      `LZ4 decompressed size mismatch: expected ${uncompressedSize}, got ${out.byteLength}`,
    );
  }
  return out;
}
