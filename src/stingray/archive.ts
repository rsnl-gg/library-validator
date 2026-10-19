import { readFile } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_MAGIC, BinaryReader, sliceExact, toHex64 } from "../core/binary.js";
import { openFileRange, readPrefix, type RangeReader } from "../core/io.js";
import { InvalidFormatError } from "../errors.js";
import { DsarReader, isDsarMagic } from "./dsar.js";

export const ARCHIVE_HEADER_SIZE = 72;
export const GAME_ASSET_TYPE_SIZE = 32;
export const GAME_ASSET_HEADER_SIZE = 80;
export const PATCH_NAME_RE = /^(.*)\.patch_(\d+)$/i;
export const BACKUP_NAME_RE = /^(.*)\.backup_(\d+)$/i;

/** One asset entry from an archive TOC. */
export interface ArchiveAsset {
  /** FileID as a 16-character hex `string`. */
  fileId: string;
  /** Type hash as a 16-character hex `string`. */
  typeId: string;
  /** Payload start offset in the archive as `number`. */
  dataOffset: number;
  /** Payload size in bytes as `number`. */
  dataSize: number;
}

/** One type-table row from an archive TOC. */
export interface ArchiveType {
  /** Type hash as a 16-character hex `string`. */
  typeId: string;
  /** Declared resource count for this type as `number`. */
  resourceCount: number;
  /** Byte offset of the uint64 resource-count field as `number`. */
  countOffset: number;
}

/** TOC asset plus the byte offset of its 80-byte header. */
export interface ArchiveTocAsset extends ArchiveAsset {
  /** Start of this 80-byte TOC header as `number`. */
  headerOffset: number;
}

/** Parsed archive header, type table, and file table. */
export interface ArchiveToc {
  /** Type-table count as `number`. */
  numTypes: number;
  /** File-table count as `number`. */
  numFiles: number;
  /** Type-table rows as `ArchiveType[]`. */
  types: ArchiveType[];
  /** File-table rows as `ArchiveTocAsset[]`. */
  assets: ArchiveTocAsset[];
}

/**
 * Parses a patch filename of the form archiveId.patch_N.
 * @param name - File basename as `string`.
 * @returns An object with `archiveId` as `string` and `patchIndex` as `number`, or `null` if the name is not a patch.
 */
export function parsePatchName(name: string): { archiveId: string; patchIndex: number } | null {
  return parseIndexedSuffix(name, PATCH_NAME_RE);
}

/**
 * Parses a backup filename of the form archiveId.backup_N.
 * @param name - File basename as `string`.
 * @returns An object with `archiveId` as `string` and `patchIndex` as `number`, or `null` if the name is not a backup.
 */
export function parseBackupName(name: string): { archiveId: string; patchIndex: number } | null {
  return parseIndexedSuffix(name, BACKUP_NAME_RE);
}

/**
 * Returns the sibling backup path for a `.patch_N` file, using `.backup_N`.
 * @param filePath - Patch file path as `string`.
 * @returns Backup path as `string`.
 */
export function toPatchBackupPath(filePath: string): string {
  const name = path.basename(filePath);
  const parsed = parsePatchName(name);
  if (!parsed) {
    throw new InvalidFormatError(`not a patch filename: ${name}`);
  }
  return path.join(path.dirname(filePath), `${parsed.archiveId}.backup_${parsed.patchIndex}`);
}

/**
 * Parses a basename of the form archiveId.suffix_N.
 * @param name - File basename as `string`.
 * @param pattern - Name pattern as `RegExp`.
 * @returns An object with `archiveId` as `string` and `patchIndex` as `number`, or `null`.
 */
function parseIndexedSuffix(
  name: string,
  pattern: RegExp,
): { archiveId: string; patchIndex: number } | null {
  const match = name.match(pattern);
  if (!match) {
    return null;
  }
  return { archiveId: match[1], patchIndex: Number(match[2]) };
}

/**
 * Computes the TOC byte length from type-table and file-table counts.
 * @param numTypes - Number of type-table entries as `number`.
 * @param numFiles - Number of file-table entries as `number`.
 * @returns TOC size in bytes as `number`.
 */
export function archiveTocSize(numTypes: number, numFiles: number): number {
  return ARCHIVE_HEADER_SIZE + numTypes * GAME_ASSET_TYPE_SIZE + numFiles * GAME_ASSET_HEADER_SIZE;
}

/**
 * Reads magic and counts from the first 12 bytes of an archive and returns the full TOC size.
 * @param data - Buffer that starts with the archive header as `Uint8Array`.
 * @returns TOC size in bytes as `number`.
 */
export function readArchiveTocSize(data: Uint8Array): number {
  const reader = new BinaryReader(data);
  if (reader.readU32() !== ARCHIVE_MAGIC) {
    throw new InvalidFormatError("invalid archive magic");
  }
  return archiveTocSize(reader.readU32(), reader.readU32());
}

/**
 * Parses the type table and file table of a decompressed archive.
 * @param data - Full archive bytes as `Uint8Array`.
 * @returns Parsed TOC as {@link ArchiveToc}.
 */
export function parseArchiveToc(data: Uint8Array): ArchiveToc {
  const reader = new BinaryReader(data);
  if (reader.readU32() !== ARCHIVE_MAGIC) {
    throw new InvalidFormatError("invalid archive magic");
  }

  const numTypes = reader.readU32();
  const numFiles = reader.readU32();
  reader.readU32();
  reader.readBytes(56);

  const tocSize = archiveTocSize(numTypes, numFiles);
  if (data.length < tocSize) {
    throw new InvalidFormatError(`archive TOC truncated: need ${tocSize}, have ${data.length}`);
  }

  const types: ArchiveType[] = [];
  for (let i = 0; i < numTypes; i++) {
    reader.seek(ARCHIVE_HEADER_SIZE + i * GAME_ASSET_TYPE_SIZE);
    reader.readU64();
    const typeId = toHex64(reader.readU64());
    const countOffset = reader.offset;
    const resourceCount = reader.readU64Number(`type[${i}].numResources`);
    types.push({ typeId, resourceCount, countOffset });
  }

  const filesStart = ARCHIVE_HEADER_SIZE + numTypes * GAME_ASSET_TYPE_SIZE;
  const assets: ArchiveTocAsset[] = [];
  for (let i = 0; i < numFiles; i++) {
    const headerOffset = filesStart + i * GAME_ASSET_HEADER_SIZE;
    reader.seek(headerOffset);
    const fileId = toHex64(reader.readU64());
    const typeId = toHex64(reader.readU64());
    const dataOffset = reader.readU64Number(`asset[${i}].dataOffset`);
    reader.readU64();
    reader.readU64();
    reader.readU64();
    reader.readU64();
    const dataSize = reader.readU32();
    assets.push({ fileId, typeId, dataOffset, dataSize, headerOffset });
  }

  return { numTypes, numFiles, types, assets };
}

/**
 * Parses a decompressed archive buffer into an archive id and asset list.
 * @param data - Full archive bytes as `Uint8Array`.
 * @param filePath - Path used to derive the archive id as `string`.
 * @returns An object with `archiveId` as `string` and `assets` as `ArchiveAsset[]`.
 */
export function parseArchive(
  data: Uint8Array,
  filePath: string,
): { archiveId: string; assets: ArchiveAsset[] } {
  const toc = parseArchiveToc(data);
  const name = path.basename(filePath);
  const patch = parsePatchName(name);
  return {
    archiveId: (patch?.archiveId ?? name).toLowerCase(),
    assets: toc.assets.map((asset) => ({
      fileId: asset.fileId,
      typeId: asset.typeId,
      dataOffset: asset.dataOffset,
      dataSize: asset.dataSize,
    })),
  };
}

/** Loaded Stingray archive or `.patch` file. */
export class Archive {
  private constructor(
    /** Absolute path of the opened file as `string`. */
    readonly filePath: string,
    /** Archive identifier derived from the filename as `string`. */
    readonly archiveId: string,
    /** Parsed TOC assets as `readonly ArchiveAsset[]`. */
    readonly assets: readonly ArchiveAsset[],
    /** True when the file on disk was a compressed DSAR container, as `boolean`. */
    readonly compressed: boolean,
    private readonly data: Uint8Array,
  ) {}

  /** Decompressed archive bytes as `Uint8Array`. */
  get bytes(): Uint8Array {
    return this.data;
  }

  /**
   * Opens a standalone archive or `.patch_N` file, decompresses DSAR if needed, and parses the TOC.
   * @param filePath - Path to the archive file as `string`.
   * @returns Promise resolving to `Archive`.
   */
  static async open(filePath: string): Promise<Archive> {
    const abs = path.resolve(filePath);
    const prefix = await readPrefix(abs, 4);
    const compressed = isDsarMagic(prefix);
    const data = compressed ? await decompressDsar(abs) : new Uint8Array(await readFile(abs));
    const parsed = parseArchive(data, abs);
    return new Archive(abs, parsed.archiveId, parsed.assets, compressed, data);
  }

  /**
   * Returns the payload bytes for one TOC asset.
   * @param asset - TOC entry as `ArchiveAsset`.
   * @returns Payload as `Uint8Array`.
   */
  read(asset: ArchiveAsset): Uint8Array {
    return sliceExact(this.data, asset.dataOffset, asset.dataSize, `${asset.fileId} data`);
  }

  /**
   * Returns TOC assets of the given type id that have a non-empty payload.
   * @param typeId - Type hash as a 16-character hex `string`.
   * @returns Matching entries as `ArchiveAsset[]`.
   */
  assetsOf(typeId: string): ArchiveAsset[] {
    return this.assets.filter((asset) => asset.typeId === typeId && asset.dataSize > 0);
  }
}

/**
 * Opens a standalone archive or `.patch_N` file for ranged reads in decompressed space.
 * DSAR containers only decompress the chunks that are actually read.
 * @param filePath - Path to the archive file as `string`.
 * @returns Promise resolving to the reader as `RangeReader` and `compressed` as `boolean`.
 */
export async function openArchiveRange(
  filePath: string,
): Promise<{ reader: RangeReader; compressed: boolean }> {
  const file = await openFileRange(filePath);
  let prefix: Uint8Array;
  try {
    prefix = await file.read(0, Math.min(4, file.length));
  } catch (error) {
    await file.close();
    throw error;
  }
  if (!isDsarMagic(prefix)) {
    return { reader: file, compressed: false };
  }

  await file.close();
  const dsar = await DsarReader.open(filePath);
  const length = dsar.structure.chunks.reduce((sum, chunk) => sum + chunk.uncompressedSize, 0);
  return {
    compressed: true,
    reader: {
      length,
      async read(offset: number, size: number): Promise<Uint8Array> {
        if (offset < 0 || size < 0 || offset + size > length) {
          throw new InvalidFormatError(
            `${path.basename(filePath)}: range ${offset}+${size} exceeds archive of ${length} bytes`,
          );
        }
        return dsar.readRange(offset, size);
      },
      close: () => dsar.close(),
    },
  };
}

/**
 * Stingray archive or `.patch` file opened for its TOC only.
 * Payloads are read on demand, so memory and I/O do not depend on the file size.
 */
export class PatchToc {
  private constructor(
    /** Absolute path of the opened file as `string`. */
    readonly filePath: string,
    /** Archive identifier derived from the filename as `string`. */
    readonly archiveId: string,
    /** Parsed TOC assets as `readonly ArchiveAsset[]`. */
    readonly assets: readonly ArchiveAsset[],
    /** True when the file on disk was a compressed DSAR container, as `boolean`. */
    readonly compressed: boolean,
    private readonly reader: RangeReader,
  ) {}

  /** Archive length in decompressed space as `number`, the size `Archive.bytes` would have. */
  get length(): number {
    return this.reader.length;
  }

  /**
   * Opens an archive and parses its TOC without reading any payload.
   * @param filePath - Path to the archive file as `string`.
   * @returns Promise resolving to `PatchToc`. Call {@link PatchToc.close} when done.
   */
  static async open(filePath: string): Promise<PatchToc> {
    const abs = path.resolve(filePath);
    const { reader, compressed } = await openArchiveRange(abs);
    try {
      const tocSize = readArchiveTocSize(await reader.read(0, 12));
      const parsed = parseArchive(await reader.read(0, tocSize), abs);
      return new PatchToc(abs, parsed.archiveId, parsed.assets, compressed, reader);
    } catch (error) {
      await reader.close();
      throw error;
    }
  }

  /**
   * Reads the payload of one TOC asset, or only its first bytes.
   * @param asset - TOC entry as `ArchiveAsset`.
   * @param size - Bytes to read from the payload start as `number`. Defaults to the whole payload.
   * @returns Promise resolving to the payload as `Uint8Array`.
   */
  read(asset: ArchiveAsset, size = asset.dataSize): Promise<Uint8Array> {
    return this.reader.read(asset.dataOffset, Math.min(size, asset.dataSize));
  }

  /**
   * Reports whether a payload lies inside the archive, as {@link Archive.read} requires.
   * @param asset - TOC entry as `ArchiveAsset`.
   * @returns `true` when the range fits, as `boolean`.
   */
  contains(asset: ArchiveAsset): boolean {
    return asset.dataOffset >= 0 && asset.dataSize >= 0 && asset.dataOffset + asset.dataSize <= this.length;
  }

  /**
   * Returns TOC assets of the given type id that have a non-empty payload.
   * @param typeId - Type hash as a 16-character hex `string`.
   * @returns Matching entries as `ArchiveAsset[]`.
   */
  assetsOf(typeId: string): ArchiveAsset[] {
    return this.assets.filter((asset) => asset.typeId === typeId && asset.dataSize > 0);
  }

  /**
   * Closes the underlying file handle.
   * @returns Promise that resolves to `void`.
   */
  close(): Promise<void> {
    return this.reader.close();
  }
}

/**
 * Fully decompresses a DSAR file into a raw archive buffer.
 * @param filePath - Path to the DSAR file as `string`.
 * @returns Promise resolving to the uncompressed archive as `Uint8Array`.
 */
async function decompressDsar(filePath: string): Promise<Uint8Array> {
  const reader = await DsarReader.open(filePath);
  try {
    return await reader.decompressAll();
  } finally {
    await reader.close();
  }
}
