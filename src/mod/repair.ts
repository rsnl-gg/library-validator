import { ByteBuffer } from "../core/buffer.js";
import { InvalidFormatError } from "../errors.js";
import {
  GAME_ASSET_HEADER_SIZE,
  parseArchiveToc,
  type ArchiveTocAsset,
} from "../stingray/archive.js";
import { patchUnitFromGame, UNIT_TYPE_ID } from "../stingray/unit.js";

const MIN_TYPE_ID = 0x1_0000_0000n;
const DATA_OFFSET_FIELD = 16;
const DATA_SIZE_FIELD = 56;

type MutableHeader = {
  fileId: string;
  typeId: string;
  dataOffset: number;
  dataSize: number;
  headerOffset: number;
};

/**
 * Rewrites unit resources in a decompressed patch so they match current game data.
 * Units missing from the game are removed from the TOC. Remaining units get the
 * game's format version and LOD-group blob, with later TOC offsets shifted by
 * any LOD-group size change.
 * @param archiveBytes - Decompressed patch bytes as `Uint8Array`.
 * @param gameUnits - FileID to current game unit payload map as `Map<string, Uint8Array>`.
 * @returns Repaired archive bytes as `Uint8Array`.
 */
export function repairPatchUnits(
  archiveBytes: Uint8Array,
  gameUnits: Map<string, Uint8Array>,
): Uint8Array {
  const toc = parseArchiveToc(archiveBytes);
  const unitType = toc.types.find((type) => type.typeId === UNIT_TYPE_ID);
  if (!unitType) {
    return archiveBytes;
  }

  for (const type of toc.types) {
    if (BigInt(`0x${type.typeId}`) < MIN_TYPE_ID) {
      throw new InvalidFormatError(`corrupted patch type id ${type.typeId}`);
    }
  }

  const headers: MutableHeader[] = toc.assets.map((asset) => headerFrom(asset));
  for (const header of headers) {
    if (header.dataOffset > archiveBytes.length) {
      throw new InvalidFormatError(`corrupted patch data offset ${header.dataOffset}`);
    }
  }

  const buffer = new ByteBuffer(archiveBytes);
  let numFiles = toc.numFiles;
  let unitCount = unitType.resourceCount;
  let headerShift = 0;
  const kept: MutableHeader[] = [];

  for (const header of headers) {
    header.headerOffset += headerShift;
    if (header.typeId === UNIT_TYPE_ID && !gameUnits.has(header.fileId)) {
      buffer.seek(header.headerOffset);
      buffer.delete(GAME_ASSET_HEADER_SIZE);
      numFiles -= 1;
      unitCount -= 1;
      headerShift -= GAME_ASSET_HEADER_SIZE;
    } else {
      kept.push(header);
    }
  }

  for (const header of kept) {
    header.dataOffset += headerShift;
  }
  kept.sort((a, b) => a.dataOffset - b.dataOffset);

  buffer.seek(8);
  buffer.writeU32(numFiles);
  buffer.seek(unitType.countOffset);
  buffer.writeU64(BigInt(unitCount));

  let sizeShift = 0;
  for (const header of kept) {
    buffer.seek(header.headerOffset + DATA_OFFSET_FIELD);
    buffer.writeU64(BigInt(header.dataOffset + sizeShift));
    const gameUnit = header.typeId === UNIT_TYPE_ID ? gameUnits.get(header.fileId) : undefined;
    if (!gameUnit) {
      continue;
    }
    const sizeDifference = patchUnitFromGame(buffer, header.dataOffset + sizeShift, gameUnit);
    buffer.seek(header.headerOffset + DATA_SIZE_FIELD);
    buffer.writeU32(header.dataSize + sizeDifference);
    sizeShift += sizeDifference;
  }

  return buffer.bytes;
}

/**
 * Copies TOC asset fields into a mutable header used while rewriting the patch.
 * @param asset - Parsed TOC asset as `ArchiveTocAsset`.
 * @returns Mutable header as `MutableHeader`.
 */
function headerFrom(asset: ArchiveTocAsset): MutableHeader {
  return {
    fileId: asset.fileId,
    typeId: asset.typeId,
    dataOffset: asset.dataOffset,
    dataSize: asset.dataSize,
    headerOffset: asset.headerOffset,
  };
}
