import { BinaryReader, DSAA_MAGIC } from "../core/binary.js";
import { InvalidFormatError } from "../errors.js";

/** One slice of a reconstructed archive inside a DSAR bundle. */
export interface BundlePackageEntry {
  /** Offset of this slice in reconstructed archive space as `number`. */
  archiveOffset: number;
  /** Offset of this slice in the uncompressed bundle as `number`. */
  uncompressedBundleOffset: number;
  /** Index into `BundleIndex.bundleNames` as `number`. */
  bundleIndex: number;
}

/** Named archive listed in the DSAA index. */
export interface BundlePackage {
  /** Package name as `string`. */
  name: string;
  /** Reconstructed archive size in bytes as `number`. */
  size: number;
  /** Bundle slices that make up this package as `BundlePackageEntry[]`. */
  entries: BundlePackageEntry[];
}

/** Full DSAA index: bundle filenames and the packages they contain. */
export interface BundleIndex {
  /** Bundle filenames as `string[]`. */
  bundleNames: string[];
  /** Packages listed in the index as `BundlePackage[]`. */
  packages: BundlePackage[];
}

/**
 * Parses a decompressed DSAA index from a slim `bundles.nxa` file.
 * @param data - Decompressed DSAA bytes as `Uint8Array`.
 * @returns Parsed index as `BundleIndex`.
 */
export function parseDsaa(data: Uint8Array): BundleIndex {
  const reader = new BinaryReader(data);
  const magic = reader.readU32();
  if (magic !== DSAA_MAGIC) {
    throw new InvalidFormatError(`invalid DSAA magic: 0x${magic.toString(16)}`);
  }

  reader.readU32();
  reader.readU32();
  const bundleCount = reader.readU32();
  const packageCount = reader.readU32();
  reader.readU32();

  const headers: Array<{
    size: number;
    filenameOffset: number;
    entriesCount: number;
    entriesOffset: number;
  }> = [];

  for (let i = 0; i < packageCount; i++) {
    headers.push({
      size: reader.readU64Number(`DSAA.package[${i}].size`),
      filenameOffset: reader.readU32(),
      entriesCount: reader.readU32(),
      entriesOffset: reader.readU64Number(`DSAA.package[${i}].entriesOffset`),
    });
  }

  const bundleNameOffsets: number[] = [];
  for (let i = 0; i < bundleCount; i++) {
    bundleNameOffsets.push(reader.readU32());
  }

  const packages: BundlePackage[] = headers.map((header) => {
    reader.seek(header.filenameOffset);
    const name = reader.readCString();
    reader.seek(header.entriesOffset);
    const entries: BundlePackageEntry[] = [];
    for (let i = 0; i < header.entriesCount; i++) {
      const archiveOffset = reader.readU64Number(`DSAA.entry[${name}][${i}].archiveOffset`);
      const uncompressedBundleOffset = reader.readU32();
      reader.readBytes(3);
      entries.push({
        archiveOffset,
        uncompressedBundleOffset,
        bundleIndex: reader.readU8(),
      });
    }
    return { name, size: header.size, entries };
  });

  return {
    bundleNames: bundleNameOffsets.map((offset) => {
      reader.seek(offset);
      return reader.readCString();
    }),
    packages,
  };
}
