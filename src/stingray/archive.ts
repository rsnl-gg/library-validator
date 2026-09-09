import { readFile } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_MAGIC, BinaryReader, sliceExact, toHex64 } from "../core/binary.js";
import { readPrefix } from "../core/io.js";
import { InvalidFormatError } from "../errors.js";
import { DsarReader, isDsarMagic } from "./dsar.js";

export const ARCHIVE_HEADER_SIZE = 72;
export const GAME_ASSET_TYPE_SIZE = 32;
export const GAME_ASSET_HEADER_SIZE = 80;
export const PATCH_NAME_RE = /^(.*)\.patch_(\d+)$/i;

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

/**
 * Parses a patch filename of the form archiveId.patch_N.
 * @param name - File basename as `string`.
 * @returns An object with `archiveId` as `string` and `patchIndex` as `number`, or `null` if the name is not a patch.
 */
export function parsePatchName(name: string): { archiveId: string; patchIndex: number } | null {
  const match = name.match(PATCH_NAME_RE);
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
 * Parses a decompressed archive buffer into an archive id and asset list.
 * @param data - Full archive bytes as `Uint8Array`.
 * @param filePath - Path used to derive the archive id as `string`.
 * @returns An object with `archiveId` as `string` and `assets` as `ArchiveAsset[]`.
 */
export function parseArchive(
  data: Uint8Array,
  filePath: string,
): { archiveId: string; assets: ArchiveAsset[] } {
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

  reader.seek(ARCHIVE_HEADER_SIZE + numTypes * GAME_ASSET_TYPE_SIZE);

  const assets: ArchiveAsset[] = [];
  for (let i = 0; i < numFiles; i++) {
    const fileId = toHex64(reader.readU64());
    const typeId = toHex64(reader.readU64());
    const dataOffset = reader.readU64Number(`asset[${i}].dataOffset`);
    reader.readU64();
    reader.readU64();
    reader.readU64();
    reader.readU64();
    const dataSize = reader.readU32();
    reader.readU32();
    reader.readU32();
    reader.readU32();
    reader.readU32();
    reader.readU32();
    assets.push({ fileId, typeId, dataOffset, dataSize });
  }

  const name = path.basename(filePath);
  const patch = parsePatchName(name);

  return {
    archiveId: (patch?.archiveId ?? name).toLowerCase(),
    assets,
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
    private readonly data: Uint8Array,
  ) {}

  /**
   * Opens a standalone archive or `.patch_N` file, decompresses DSAR if needed, and parses the TOC.
   * @param filePath - Path to the archive file as `string`.
   * @returns Promise resolving to `Archive`.
   */
  static async open(filePath: string): Promise<Archive> {
    const abs = path.resolve(filePath);
    const prefix = await readPrefix(abs, 4);
    const data = isDsarMagic(prefix) ? await decompressDsar(abs) : new Uint8Array(await readFile(abs));
    const parsed = parseArchive(data, abs);
    return new Archive(abs, parsed.archiveId, parsed.assets, data);
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
