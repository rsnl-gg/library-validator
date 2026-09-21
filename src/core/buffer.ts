import { InvalidFormatError } from "../errors.js";
import { readU32, writeU32, writeU64 } from "./binary.js";

/** Growable little-endian byte buffer with insert/delete at the cursor. */
export class ByteBuffer {
  private data: Uint8Array;
  /** Current read/write cursor in bytes as `number`. */
  offset = 0;

  /**
   * Copies `bytes` so later inserts and deletes do not mutate the source.
   * @param bytes - Initial contents as `Uint8Array`.
   * @returns The new buffer as `ByteBuffer`.
   */
  constructor(bytes: Uint8Array) {
    this.data = bytes.slice();
  }

  /** Current contents as `Uint8Array`. */
  get bytes(): Uint8Array {
    return this.data;
  }

  /** Current length in bytes as `number`. */
  get length(): number {
    return this.data.length;
  }

  /**
   * Moves the cursor to an absolute offset, growing the buffer with zeros if needed.
   * @param offset - New cursor position as `number`.
   * @returns Nothing, typed as `void`.
   */
  seek(offset: number): void {
    if (offset < 0) {
      throw new InvalidFormatError(`seek out of range: ${offset}`);
    }
    this.grow(offset);
    this.offset = offset;
  }

  /**
   * Moves the cursor by a relative amount. Negative moves clamp at 0.
   * @param delta - Signed byte delta as `number`.
   * @returns Nothing, typed as `void`.
   */
  skip(delta: number): void {
    this.seek(Math.max(0, this.offset + delta));
  }

  /**
   * Reads a little-endian uint32 at the cursor and advances by 4.
   * @returns The value as `number`.
   */
  readU32(): number {
    const value = readU32(this.data, this.offset);
    this.offset += 4;
    return value;
  }

  /**
   * Writes a little-endian uint32 at the cursor and advances by 4.
   * @param value - Value to write as `number`.
   * @returns Nothing, typed as `void`.
   */
  writeU32(value: number): void {
    this.grow(this.offset + 4);
    writeU32(this.data, this.offset, value);
    this.offset += 4;
  }

  /**
   * Writes a little-endian uint64 at the cursor and advances by 8.
   * @param value - Value to write as `bigint`.
   * @returns Nothing, typed as `void`.
   */
  writeU64(value: bigint): void {
    this.grow(this.offset + 8);
    writeU64(this.data, this.offset, value);
    this.offset += 8;
  }

  /**
   * Overwrites bytes at the cursor and advances by their length.
   * @param bytes - Bytes to write as `Uint8Array`.
   * @returns Nothing, typed as `void`.
   */
  writeBytes(bytes: Uint8Array): void {
    this.grow(this.offset + bytes.length);
    this.data.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  /**
   * Inserts `length` zero bytes at the cursor. The cursor stays put.
   * @param length - Number of bytes to insert as `number`.
   * @returns Nothing, typed as `void`.
   */
  insert(length: number): void {
    if (length <= 0) {
      return;
    }
    const next = new Uint8Array(this.data.length + length);
    next.set(this.data.subarray(0, this.offset), 0);
    next.set(this.data.subarray(this.offset), this.offset + length);
    this.data = next;
  }

  /**
   * Removes `length` bytes at the cursor. The cursor stays put.
   * @param length - Number of bytes to remove as `number`.
   * @returns Nothing, typed as `void`.
   */
  delete(length: number): void {
    if (length <= 0) {
      return;
    }
    if (this.offset + length > this.data.length) {
      throw new InvalidFormatError(
        `delete past end of buffer: ${length} bytes at ${this.offset}, size ${this.data.length}`,
      );
    }
    const next = new Uint8Array(this.data.length - length);
    next.set(this.data.subarray(0, this.offset), 0);
    next.set(this.data.subarray(this.offset + length), this.offset);
    this.data = next;
  }

  /**
   * Extends the buffer with zeros up to `size` if it is currently shorter.
   * @param size - Required length as `number`.
   * @returns Nothing, typed as `void`.
   */
  private grow(size: number): void {
    if (size <= this.data.length) {
      return;
    }
    const next = new Uint8Array(size);
    next.set(this.data);
    this.data = next;
  }
}
