import type { ByteBuffer } from "../core/buffer.js";
import { readU32, sliceExact } from "../core/binary.js";
import { InvalidFormatError } from "../errors.js";
import type { ArchiveAsset } from "./archive.js";

export const UNIT_TYPE_ID = "e0a48d0be9a7453f";
export const UNIT_VERSION_OFFSET = 44;
export const UNIT_VERSION_BYTES = UNIT_VERSION_OFFSET + 4;
export const UNIT_LOD_GROUP_OFFSET = 48;
export const UNIT_OFFSET_TABLE = 52;
export const UNIT_OFFSET_COUNT = 16;
export const UNIT_LAYOUT_LIST_OFFSET = 92;
export const UNIT_LAYOUT_MIGRATE_BEFORE = 0xa4cd36;
export const UNIT_LAYOUT_ITEM_SIZE = 20;

/** Version and LOD-group blob copied from current game unit data. */
export interface UnitLodGroup {
  /** Unit format version as `number`. */
  version: number;
  /** LOD-group bytes between the LOD-group and joint-list offsets, as `Uint8Array`. */
  lodGroup: Uint8Array;
}

/**
 * Reads the unit format version from a unit payload.
 * The value is a little-endian uint32 at byte 44.
 * @param data - Unit main payload as `Uint8Array`.
 * @returns The version as `number`.
 */
export function readUnitVersion(data: Uint8Array): number {
  if (data.length < UNIT_VERSION_BYTES) {
    throw new InvalidFormatError(`unit data too small to read version: ${data.length} bytes`);
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(UNIT_VERSION_OFFSET, true);
}

/**
 * Reads the version and LOD-group blob from a game unit payload.
 * @param data - Unit main payload as `Uint8Array`.
 * @returns Version and LOD-group as {@link UnitLodGroup}.
 */
export function readUnitLodGroup(data: Uint8Array): UnitLodGroup {
  if (data.length < UNIT_OFFSET_TABLE + 4) {
    throw new InvalidFormatError(`unit data too small to read lod group: ${data.length} bytes`);
  }
  const lodGroupOffset = readU32(data, UNIT_LOD_GROUP_OFFSET);
  const jointListOffset = readU32(data, UNIT_OFFSET_TABLE);
  if (lodGroupOffset === 0 || jointListOffset < lodGroupOffset) {
    throw new InvalidFormatError(
      `invalid lod group range ${lodGroupOffset}..${jointListOffset} in unit of ${data.length} bytes`,
    );
  }
  return {
    version: readUnitVersion(data),
    lodGroup: sliceExact(data, lodGroupOffset, jointListOffset - lodGroupOffset, "lod group"),
  };
}

/**
 * For units older than {@link UNIT_LAYOUT_MIGRATE_BEFORE}, adds 4 to vertex-layout
 * item formats greater than 16 so they match the current game layout encoding.
 * @param buffer - Archive buffer positioned anywhere as `ByteBuffer`.
 * @param unitStart - Start offset of the unit payload as `number`.
 * @returns Nothing, typed as `void`.
 */
export function migrateUnitVertexLayouts(buffer: ByteBuffer, unitStart: number): void {
  if (unitStart + UNIT_LAYOUT_LIST_OFFSET + 4 > buffer.length) {
    return;
  }
  buffer.seek(unitStart + UNIT_LAYOUT_LIST_OFFSET);
  const listStart = unitStart + buffer.readU32();
  if (listStart + 4 > buffer.length) {
    return;
  }
  buffer.seek(listStart);
  const layoutCount = buffer.readU32();
  const layoutOffsets: number[] = [];
  for (let i = 0; i < layoutCount; i++) {
    if (buffer.offset + 4 > buffer.length) {
      return;
    }
    layoutOffsets.push(buffer.readU32());
  }
  for (const layoutOffset of layoutOffsets) {
    buffer.seek(listStart + layoutOffset);
    buffer.skip(8);
    for (let i = 0; i < UNIT_OFFSET_COUNT; i++) {
      if (buffer.offset + 8 > buffer.length) {
        return;
      }
      buffer.readU32();
      const itemFormat = buffer.readU32();
      if (itemFormat > 16) {
        buffer.skip(-4);
        buffer.writeU32(itemFormat + 4);
      }
      buffer.skip(UNIT_LAYOUT_ITEM_SIZE - 8);
    }
  }
}

/**
 * Rewrites a patch unit in place: optional layout migration, then game version and LOD group.
 * Offsets after the LOD group are shifted by the LOD-group size delta.
 * @param buffer - Full archive buffer as `ByteBuffer`.
 * @param unitStart - Start offset of the unit payload as `number`.
 * @param gameUnit - Current game unit payload as `Uint8Array`.
 * @returns LOD-group size delta as `number` (game size minus patch size).
 */
export function patchUnitFromGame(buffer: ByteBuffer, unitStart: number, gameUnit: Uint8Array): number {
  const game = readUnitLodGroup(gameUnit);

  buffer.seek(unitStart + UNIT_VERSION_OFFSET);
  if (buffer.readU32() < UNIT_LAYOUT_MIGRATE_BEFORE) {
    migrateUnitVertexLayouts(buffer, unitStart);
  }

  buffer.seek(unitStart + UNIT_VERSION_OFFSET);
  buffer.writeU32(game.version);
  const lodGroupOffset = buffer.readU32();
  const jointListOffset = buffer.readU32();
  if (lodGroupOffset === 0 || jointListOffset < lodGroupOffset) {
    throw new InvalidFormatError(
      `invalid lod group range ${lodGroupOffset}..${jointListOffset} in patch unit`,
    );
  }

  const sizeDifference = game.lodGroup.length - (jointListOffset - lodGroupOffset);
  buffer.seek(unitStart + lodGroupOffset);
  if (sizeDifference > 0) {
    buffer.insert(sizeDifference);
  } else {
    buffer.delete(-sizeDifference);
  }

  buffer.seek(unitStart + UNIT_OFFSET_TABLE);
  for (let i = 0; i < UNIT_OFFSET_COUNT; i++) {
    const offset = buffer.readU32();
    if (offset !== 0 && offset > lodGroupOffset) {
      buffer.skip(-4);
      buffer.writeU32(offset + sizeDifference);
    }
  }

  buffer.seek(unitStart + lodGroupOffset);
  buffer.writeBytes(game.lodGroup);
  return sizeDifference;
}

/**
 * Filters TOC entries that are units and large enough to contain a version field.
 * When fileIds is empty every such unit is kept; otherwise only matching FileIDs.
 * @param assets - Archive TOC assets as `readonly ArchiveAsset[]`.
 * @param fileIds - FileIDs to keep as `Set<string>`, or an empty set to keep all units.
 * @returns Matching units as `ArchiveAsset[]`.
 */
export function unitAssets(assets: readonly ArchiveAsset[], fileIds: Set<string>): ArchiveAsset[] {
  return assets.filter(
    (asset) =>
      asset.typeId === UNIT_TYPE_ID &&
      asset.dataSize >= UNIT_VERSION_BYTES &&
      (fileIds.size === 0 || fileIds.has(asset.fileId)),
  );
}
