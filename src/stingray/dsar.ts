import { open } from "node:fs/promises";
import path from "node:path";
import { BinaryReader, DSAR_MAGIC, readU32 } from "../core/binary.js";
import { lz4DecompressBlock } from "../core/lz4.js";
import { InvalidFormatError } from "../errors.js";

export const DSAR_UNCOMPRESSED = 0x00;
export const DSAR_LZ4 = 0x03;

/** One compressed or uncompressed slice of a DSAR container. */
export interface DsarChunk {
  /** Start of this chunk in uncompressed space as `number`. */
  uncompressedOffset: number;
  /** Start of this chunk in the compressed file as `number`. */
  compressedOffset: number;
  /** Uncompressed size in bytes as `number`. */
  uncompressedSize: number;
  /** Compressed size in bytes as `number`. */
  compressedSize: number;
  /** Compression codec id as `number`. */
  compression: number;
  /** Chunk flags as `number`. */
  flags: number;
}

/** Parsed DSAR header and chunk table. */
export interface DsarStructure {
  /** Source file path as `string`. */
  path: string;
  /** Unknown header field as `number`. */
  unknown0: number;
  /** Combined header and chunk-table size as `number`. */
  headerAndChunkInfoSize: number;
  /** Total uncompressed payload size as `number`. */
  uncompressedDataSize: number;
  /** Chunk table as `DsarChunk[]`. */
  chunks: DsarChunk[];
}

/**
 * Reports whether a buffer starts with the DSAR magic.
 * @param data - Bytes to inspect as `Uint8Array`.
 * @returns `true` if the magic matches, otherwise `false`, as `boolean`.
 */
export function isDsarMagic(data: Uint8Array): boolean {
  return data.length >= 4 && readU32(data, 0) === DSAR_MAGIC;
}

/**
 * Parses a DSAR header and chunk table already loaded in memory.
 * @param data - Header and chunk table bytes as `Uint8Array`.
 * @param filePath - Optional source path stored on the result as `string`.
 * @returns Parsed header as `DsarStructure`.
 */
export function parseDsarStructure(data: Uint8Array, filePath = ""): DsarStructure {
  const reader = new BinaryReader(data);
  const magic = reader.readU32();
  if (magic !== DSAR_MAGIC) {
    throw new InvalidFormatError(`invalid DSAR magic: 0x${magic.toString(16)}`);
  }

  const unknown0 = reader.readU32();
  const chunkCount = reader.readU32();
  const headerAndChunkInfoSize = reader.readU32();
  const uncompressedDataSize = reader.readU64Number("DSAR.uncompressedDataSize");
  reader.readBytes(8);

  const chunks: DsarChunk[] = [];
  for (let i = 0; i < chunkCount; i++) {
    chunks.push({
      uncompressedOffset: reader.readU64Number(`DSAR.chunk[${i}].uncompressedOffset`),
      compressedOffset: reader.readU64Number(`DSAR.chunk[${i}].compressedOffset`),
      uncompressedSize: reader.readU32(),
      compressedSize: reader.readU32(),
      compression: reader.readU8(),
      flags: reader.readU8(),
    });
    reader.readBytes(6);
  }

  return {
    path: filePath,
    unknown0,
    headerAndChunkInfoSize,
    uncompressedDataSize,
    chunks,
  };
}

/**
 * Finds the chunk that covers an uncompressed byte offset.
 * @param chunks - DSAR chunk table as `DsarChunk[]`.
 * @param uncompressedOffset - Offset in uncompressed space as `number`.
 * @returns Chunk table index as `number`.
 */
export function findChunkIndex(chunks: DsarChunk[], uncompressedOffset: number): number {
  let low = 0;
  let high = chunks.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = chunks[mid].uncompressedOffset;
    if (start === uncompressedOffset) {
      return mid;
    }
    if (start < uncompressedOffset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (
      uncompressedOffset >= chunk.uncompressedOffset &&
      uncompressedOffset < chunk.uncompressedOffset + chunk.uncompressedSize
    ) {
      return i;
    }
  }

  throw new InvalidFormatError(`no DSAR chunk covers uncompressed offset ${uncompressedOffset}`);
}

/**
 * Decompresses one DSAR chunk to its uncompressed bytes.
 * @param compressed - Compressed chunk payload as `Uint8Array`.
 * @param chunk - Chunk header as `DsarChunk`.
 * @returns Uncompressed bytes as `Uint8Array`.
 */
export function decompressDsarChunk(compressed: Uint8Array, chunk: DsarChunk): Uint8Array {
  if (compressed.length !== chunk.compressedSize) {
    throw new InvalidFormatError(
      `DSAR chunk size mismatch: expected ${chunk.compressedSize}, read ${compressed.length}`,
    );
  }

  if (chunk.compression === DSAR_UNCOMPRESSED) {
    if (compressed.length !== chunk.uncompressedSize) {
      throw new InvalidFormatError("uncompressed DSAR chunk size does not match header");
    }
    return compressed;
  }

  if (chunk.compression === DSAR_LZ4) {
    return lz4DecompressBlock(compressed, chunk.uncompressedSize);
  }

  throw new InvalidFormatError(`unknown DSAR compression 0x${chunk.compression.toString(16)}`);
}

/** On-demand reader for a DSAR file. Opens the handle and decompresses only needed chunks. */
export class DsarReader {
  /** Parsed header and chunk table as `DsarStructure`. */
  readonly structure: DsarStructure;
  private handle: Awaited<ReturnType<typeof open>> | null = null;

  /**
   * Creates a reader over an already-parsed DSAR structure.
   * @param filePath - Path to the DSAR file as `string`.
   * @param structure - Parsed header as `DsarStructure`.
   * @returns The new reader as `DsarReader`.
   */
  constructor(
    /** Path to the DSAR file as `string`. */
    readonly filePath: string,
    structure: DsarStructure,
  ) {
    this.structure = structure;
  }

  /**
   * Opens a DSAR file and reads its chunk table.
   * @param filePath - Path to the file as `string`.
   * @returns Promise resolving to `DsarReader`.
   */
  static async open(filePath: string): Promise<DsarReader> {
    const handle = await open(filePath, "r");
    try {
      const header = Buffer.alloc(32);
      const { bytesRead } = await handle.read(header, 0, 32, 0);
      if (bytesRead < 32) {
        throw new InvalidFormatError(`truncated DSAR header in ${filePath}`);
      }
      const chunkCount = header.readUInt32LE(8);
      const tableSize = 32 + chunkCount * 32;
      const table = Buffer.alloc(tableSize);
      header.copy(table, 0, 0, 32);
      const rest = await handle.read(table, 32, tableSize - 32, 32);
      if (rest.bytesRead < tableSize - 32) {
        throw new InvalidFormatError(`truncated DSAR chunk table in ${filePath}`);
      }
      const structure = parseDsarStructure(table, filePath);
      const reader = new DsarReader(filePath, structure);
      reader.handle = handle;
      return reader;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /**
   * Decompresses a single chunk by table index.
   * @param index - Chunk table index as `number`.
   * @returns Promise resolving to uncompressed bytes as `Uint8Array`.
   */
  async readChunk(index: number): Promise<Uint8Array> {
    const chunk = this.structure.chunks[index];
    if (!chunk) {
      throw new InvalidFormatError(`DSAR chunk ${index} out of range`);
    }
    const handle = this.handle ?? (this.handle = await open(this.filePath, "r"));
    const compressed = Buffer.alloc(chunk.compressedSize);
    const { bytesRead } = await handle.read(
      compressed,
      0,
      chunk.compressedSize,
      chunk.compressedOffset,
    );
    if (bytesRead !== chunk.compressedSize) {
      throw new InvalidFormatError(`truncated DSAR chunk ${index} in ${path.basename(this.filePath)}`);
    }
    return decompressDsarChunk(compressed, chunk);
  }

  /**
   * Reads uncompressed bytes from the given offset.
   * @param uncompressedOffset - Start offset in uncompressed space as `number`.
   * @param size - Number of bytes to read as `number`.
   * @returns Promise resolving to the requested range as `Uint8Array`.
   */
  async readRange(uncompressedOffset: number, size: number): Promise<Uint8Array> {
    if (size === 0) {
      return new Uint8Array(0);
    }

    const out = new Uint8Array(size);
    let written = 0;
    let index = findChunkIndex(this.structure.chunks, uncompressedOffset);

    while (written < size) {
      if (index >= this.structure.chunks.length) {
        throw new InvalidFormatError(
          `ran out of DSAR chunks while reading ${size} bytes at ${uncompressedOffset}`,
        );
      }
      const chunk = this.structure.chunks[index];
      const data = await this.readChunk(index);
      const skip = Math.max(0, uncompressedOffset + written - chunk.uncompressedOffset);
      const take = Math.min(data.length - skip, size - written);
      if (take < 0 || skip > data.length) {
        throw new InvalidFormatError(`DSAR range alignment error at chunk ${index}`);
      }
      out.set(data.subarray(skip, skip + take), written);
      written += take;
      index += 1;
    }

    return out;
  }

  /**
   * Decompresses every chunk and concatenates them in order.
   * @returns Promise resolving to the full uncompressed payload as `Uint8Array`.
   */
  async decompressAll(): Promise<Uint8Array> {
    const total = this.structure.chunks.reduce((sum, chunk) => sum + chunk.uncompressedSize, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < this.structure.chunks.length; i++) {
      const data = await this.readChunk(i);
      out.set(data, offset);
      offset += data.length;
    }
    return out;
  }

  /**
   * Closes the underlying file handle.
   * @returns Promise that resolves to `void`.
   */
  async close(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }
}
