import { InvalidFormatError } from "../errors.js";

export const ARCHIVE_MAGIC = 0xf0000011;
export const DSAR_MAGIC = 0x52415344;
export const DSAA_MAGIC = 0x41415344;

/**
 * Formats a 64-bit id as a 16-character lowercase hex string.
 * @param value - Unsigned 64-bit id as `bigint`.
 * @returns Hex string of type `string`.
 */
export function toHex64(value: bigint): string {
  return value.toString(16).padStart(16, "0");
}

/**
 * Converts a bigint to a JS number. Throws {@link InvalidFormatError} if the value is outside the safe integer range.
 * @param value - Value as `bigint`.
 * @param label - Name used in the error message as `string`.
 * @returns The value as `number`.
 */
export function toSafeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidFormatError(`${label} (${value}) does not fit in a safe JS number`);
  }
  return Number(value);
}

/** Sequential little-endian reader over a byte buffer. */
export class BinaryReader {
  /** Backing buffer as `Uint8Array`. */
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  /** Current read cursor in bytes as `number`. */
  offset = 0;

  /**
   * Creates a sequential little-endian reader over a byte buffer.
   * @param data - Buffer to read from as `Uint8Array`.
   * @returns The new reader as `BinaryReader`.
   */
  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  /** Total buffer length as `number`. */
  get length(): number {
    return this.bytes.length;
  }

  /**
   * Returns how many bytes remain from the current offset.
   * @returns Remaining length as `number`.
   */
  remaining(): number {
    return this.bytes.length - this.offset;
  }

  /**
   * Moves the read cursor to an absolute offset.
   * @param offset - New cursor position as `number`.
   * @returns Nothing, typed as `void`.
   */
  seek(offset: number): void {
    if (offset < 0 || offset > this.bytes.length) {
      throw new InvalidFormatError(`seek out of range: ${offset} (size ${this.bytes.length})`);
    }
    this.offset = offset;
  }

  /**
   * Throws {@link InvalidFormatError} if fewer than the requested bytes remain.
   * @param size - Number of bytes required as `number`.
   * @returns Nothing, typed as `void`.
   */
  private require(size: number): void {
    if (this.offset + size > this.bytes.length) {
      throw new InvalidFormatError(
        `read past end of buffer: need ${size} bytes at ${this.offset}, size ${this.bytes.length}`,
      );
    }
  }

  /**
   * Reads the next unsigned 8-bit integer and advances the cursor.
   * @returns The value as `number`.
   */
  readU8(): number {
    this.require(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  /**
   * Reads the next unsigned 16-bit little-endian integer and advances the cursor.
   * @returns The value as `number`.
   */
  readU16(): number {
    this.require(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  /**
   * Reads the next unsigned 32-bit little-endian integer and advances the cursor.
   * @returns The value as `number`.
   */
  readU32(): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /**
   * Reads the next unsigned 64-bit little-endian integer and advances the cursor.
   * @returns The value as `bigint`.
   */
  readU64(): bigint {
    this.require(8);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  /**
   * Reads a uint64 and converts it to a safe JS number.
   * @param label - Name used in the error message if the value does not fit, as `string`.
   * @returns The value as `number`.
   */
  readU64Number(label: string): number {
    return toSafeNumber(this.readU64(), label);
  }

  /**
   * Reads the next bytes and advances the cursor.
   * @param size - Number of bytes to read as `number`.
   * @returns Slice as `Uint8Array`.
   */
  readBytes(size: number): Uint8Array {
    this.require(size);
    const slice = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return slice;
  }

  /**
   * Reads a NUL-terminated UTF-8 string.
   * @returns Decoded text as `string`.
   */
  readCString(): string {
    const start = this.offset;
    while (this.offset < this.bytes.length && this.bytes[this.offset] !== 0) {
      this.offset += 1;
    }
    const text = new TextDecoder().decode(this.bytes.subarray(start, this.offset));
    if (this.offset < this.bytes.length) {
      this.offset += 1;
    }
    return text;
  }
}

/**
 * Reads a little-endian uint32 at an absolute offset.
 * @param data - Buffer as `Uint8Array`.
 * @param offset - Byte offset as `number`.
 * @returns The value as `number`.
 */
export function readU32(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) {
    throw new InvalidFormatError(`uint32 read out of range at ${offset}`);
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

/**
 * Returns a slice of a buffer at an offset with a given length.
 * Throws {@link InvalidFormatError} if the range would run past the buffer.
 * @param data - Buffer as `Uint8Array`.
 * @param offset - Start offset as `number`.
 * @param size - Length as `number`.
 * @param label - Name used in the error message as `string`.
 * @returns Slice as `Uint8Array`.
 */
export function sliceExact(
  data: Uint8Array,
  offset: number,
  size: number,
  label: string,
): Uint8Array {
  if (size === 0) {
    return new Uint8Array(0);
  }
  if (offset < 0 || size < 0 || offset + size > data.length) {
    throw new InvalidFormatError(
      `${label}: range ${offset}+${size} exceeds buffer of ${data.length} bytes`,
    );
  }
  return data.subarray(offset, offset + size);
}
