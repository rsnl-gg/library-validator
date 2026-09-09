import { InvalidFormatError } from "../errors.js";
import type { ArchiveAsset } from "./archive.js";

export const UNIT_TYPE_ID = "e0a48d0be9a7453f";
export const UNIT_VERSION_OFFSET = 44;
export const UNIT_VERSION_BYTES = UNIT_VERSION_OFFSET + 4;

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
