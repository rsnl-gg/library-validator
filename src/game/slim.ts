import { existsSync } from "node:fs";
import path from "node:path";
import { InvalidFormatError } from "../errors.js";
import { parseArchive, readArchiveTocSize, type ArchiveAsset } from "../stingray/archive.js";
import { parseDsaa, type BundleIndex, type BundlePackage } from "../stingray/dsaa.js";
import { DsarReader } from "../stingray/dsar.js";

/**
 * Reports whether a directory looks like a slim game-data install.
 * @param dir - Directory to inspect as `string`.
 * @returns `true` if `bundles.nxa` is present, otherwise `false`, as `boolean`.
 */
export function isSlimGameDir(dir: string): boolean {
  return existsSync(path.join(dir, "bundles.nxa"));
}

/** Open slim game data: DSAA index from `bundles.nxa` plus lazy DSAR bundle readers. */
export class SlimSession {
  private constructor(
    /** Absolute path of the game data directory as `string`. */
    readonly gameDir: string,
    /** Parsed DSAA index as `BundleIndex`. */
    readonly index: BundleIndex,
    private readonly readers: Map<string, DsarReader>,
  ) {}

  /**
   * Decompresses `bundles.nxa` and parses the DSAA package index.
   * @param gameDir - Path to the data folder as `string`.
   * @returns Promise resolving to `SlimSession`.
   */
  static async open(gameDir: string): Promise<SlimSession> {
    const reader = await DsarReader.open(path.join(gameDir, "bundles.nxa"));
    try {
      return new SlimSession(gameDir, parseDsaa(await reader.decompressAll()), new Map());
    } finally {
      await reader.close();
    }
  }

  /**
   * Returns packages that are main archives.
   * @returns Main packages as `BundlePackage[]`.
   */
  mainPackages(): BundlePackage[] {
    return this.index.packages.filter((pkg) => !pkg.name.includes("."));
  }

  /**
   * Rebuilds and parses the TOC of one slim package.
   * @param pkg - Package to read as `BundlePackage`.
   * @returns Promise resolving to an object with `archiveId` as `string` and `assets` as `ArchiveAsset[]`.
   */
  async parseToc(pkg: BundlePackage): Promise<{ archiveId: string; assets: ArchiveAsset[] }> {
    return parseArchive(await this.reconstructToc(pkg), pkg.name);
  }

  /**
   * Reads bytes from a reconstructed archive.
   * @param pkg - Package to read as `BundlePackage`.
   * @param offset - Start offset in reconstructed archive space as `number`.
   * @param size - Number of bytes to read as `number`.
   * @returns Promise resolving to the requested range as `Uint8Array`.
   */
  async readRange(pkg: BundlePackage, offset: number, size: number): Promise<Uint8Array> {
    const out = new Uint8Array(size);
    const from = offset;
    const to = offset + size;
    let filled = 0;

    for (let i = 0; i < pkg.entries.length && filled < size; i++) {
      const start = pkg.entries[i].archiveOffset;
      const end = start + entrySize(pkg, i);
      const overlapStart = Math.max(from, start);
      const overlapEnd = Math.min(to, end);
      if (overlapStart >= overlapEnd) {
        continue;
      }
      const data = await this.readEntry(pkg, i);
      out.set(data.subarray(overlapStart - start, overlapEnd - start), overlapStart - from);
      filled += overlapEnd - overlapStart;
    }

    if (filled < size) {
      throw new InvalidFormatError(`could not read ${size} bytes at ${offset} from ${pkg.name}`);
    }
    return out;
  }

  /**
   * Closes every open bundle reader.
   * @returns Promise that resolves to `void`.
   */
  async close(): Promise<void> {
    await Promise.all([...this.readers.values()].map((reader) => reader.close()));
    this.readers.clear();
  }

  /**
   * Returns a cached DSAR reader for a bundle, opening it on first use.
   * @param bundleName - Bundle filename as `string`.
   * @returns Promise resolving to `DsarReader`.
   */
  private async bundleReader(bundleName: string): Promise<DsarReader> {
    const existing = this.readers.get(bundleName);
    if (existing) {
      return existing;
    }
    const reader = await DsarReader.open(path.join(this.gameDir, bundleName));
    this.readers.set(bundleName, reader);
    return reader;
  }

  /**
   * Reads one DSAA package entry from its bundle.
   * @param pkg - Package that owns the entry as `BundlePackage`.
   * @param index - Entry index as `number`.
   * @returns Promise resolving to the slice as `Uint8Array`.
   */
  private async readEntry(pkg: BundlePackage, index: number): Promise<Uint8Array> {
    const entry = pkg.entries[index];
    const size = entrySize(pkg, index);
    if (size < 0) {
      throw new InvalidFormatError(`invalid DSAA entry size for ${pkg.name}[${index}]`);
    }
    const bundleName = this.index.bundleNames[entry.bundleIndex];
    if (!bundleName) {
      throw new InvalidFormatError(`bundle index ${entry.bundleIndex} missing for ${pkg.name}`);
    }
    return (await this.bundleReader(bundleName)).readRange(entry.uncompressedBundleOffset, size);
  }

  /**
   * Concatenates leading bundle slices until the archive TOC is complete.
   * @param pkg - Package to reconstruct as `BundlePackage`.
   * @returns Promise resolving to the TOC bytes as `Uint8Array`.
   */
  private async reconstructToc(pkg: BundlePackage): Promise<Uint8Array> {
    if (pkg.entries.length === 0) {
      return new Uint8Array(0);
    }
    if (pkg.entries[0].archiveOffset !== 0) {
      throw new InvalidFormatError(`expected first entry of ${pkg.name} at offset 0`);
    }

    let combined = await this.readEntry(pkg, 0);
    const tocSize = readArchiveTocSize(combined);
    let index = 1;
    while (combined.length < tocSize && index < pkg.entries.length) {
      const next = await this.readEntry(pkg, index);
      const merged = new Uint8Array(combined.length + next.length);
      merged.set(combined, 0);
      merged.set(next, combined.length);
      combined = merged;
      index += 1;
    }
    if (combined.length < tocSize) {
      throw new InvalidFormatError(`could not reconstruct TOC for ${pkg.name}`);
    }
    return combined.subarray(0, tocSize);
  }
}

/**
 * Returns the byte length of a package entry in reconstructed archive space.
 * @param pkg - Package that owns the entry as `BundlePackage`.
 * @param index - Entry index as `number`.
 * @returns Entry length in bytes as `number`.
 */
function entrySize(pkg: BundlePackage, index: number): number {
  const entry = pkg.entries[index];
  const next = pkg.entries[index + 1];
  return next ? next.archiveOffset - entry.archiveOffset : pkg.size - entry.archiveOffset;
}
