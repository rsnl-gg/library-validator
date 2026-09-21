import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ARCHIVE_MAGIC } from "../src/core/binary.js";
import {
  ARCHIVE_HEADER_SIZE,
  GAME_ASSET_HEADER_SIZE,
  GAME_ASSET_TYPE_SIZE,
} from "../src/stingray/archive.js";
import { LUA_TYPE_ID } from "../src/stingray/lua.js";
import { UNIT_TYPE_ID } from "../src/stingray/unit.js";

export const UNIT_TYPE = BigInt(`0x${UNIT_TYPE_ID}`);
export const LUA_TYPE = BigInt(`0x${LUA_TYPE_ID}`);
export const TEXTURE_TYPE = 0xcd4238c6a0c69e32n;
export const SAMPLE_FILE_ID = 0x1234567890abcdefn;
export const SAMPLE_FILE_ID_HEX = SAMPLE_FILE_ID.toString(16);
export const UNIT_LOD_HEADER = 0x74;

function writeU32(buffer: Uint8Array, offset: number, value: number): void {
  new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(offset, value, true);
}

function writeU64(buffer: Uint8Array, offset: number, value: bigint): void {
  new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setBigUint64(offset, value, true);
}

/** Builds a 64-byte unit payload with the given format version at byte 44. */
export function buildUnitPayload(version: number): Uint8Array {
  const payload = new Uint8Array(64);
  writeU32(payload, 44, version);
  return payload;
}

/**
 * Builds a unit payload with a version field and a LOD-group blob after the 16-offset table.
 * @param version - Unit format version as `number`.
 * @param lodGroup - LOD-group bytes as `Uint8Array`.
 * @returns Payload as `Uint8Array`.
 */
export function buildRepairUnitPayload(version: number, lodGroup: Uint8Array): Uint8Array {
  const payload = new Uint8Array(UNIT_LOD_HEADER + lodGroup.length);
  writeU32(payload, 44, version);
  writeU32(payload, 48, UNIT_LOD_HEADER);
  writeU32(payload, 52, UNIT_LOD_HEADER + lodGroup.length);
  payload.set(lodGroup, UNIT_LOD_HEADER);
  return payload;
}

/**
 * Builds an old-format unit that includes a vertex layout list with one 16-item layout.
 * @param version - Unit format version as `number`.
 * @param lodGroup - LOD-group bytes as `Uint8Array`.
 * @param itemFormat - Vertex layout item format written to every slot as `number`.
 * @returns Payload as `Uint8Array`.
 */
export function buildLayoutUnitPayload(version: number, lodGroup: Uint8Array, itemFormat: number): Uint8Array {
  const lodOffset = UNIT_LOD_HEADER;
  const layoutListOffset = lodOffset + lodGroup.length;
  const layoutHeader = 8;
  const layoutBody = 8 + 16 * 20;
  const payload = new Uint8Array(layoutListOffset + layoutHeader + layoutBody);
  writeU32(payload, 44, version);
  writeU32(payload, 48, lodOffset);
  writeU32(payload, 52, layoutListOffset);
  writeU32(payload, 92, layoutListOffset);
  payload.set(lodGroup, lodOffset);
  writeU32(payload, layoutListOffset, 1);
  writeU32(payload, layoutListOffset + 4, 8);
  const itemsStart = layoutListOffset + 16;
  for (let i = 0; i < 16; i++) {
    writeU32(payload, itemsStart + i * 20 + 4, itemFormat);
  }
  return payload;
}

/** Builds a Stingray Lua asset payload with an 8-byte header plus UTF-8 source. */
export function buildLuaPayload(source: string): Uint8Array {
  return buildLuaPayloadFromBytes(Buffer.from(source, "utf8"));
}

/** Builds a Stingray Lua asset payload with an 8-byte header plus raw body bytes. */
export function buildLuaPayloadFromBytes(body: Uint8Array): Uint8Array {
  const payload = new Uint8Array(8 + body.length);
  writeU32(payload, 0, body.length);
  writeU32(payload, 4, 2);
  payload.set(body, 8);
  return payload;
}

/** Minimal stripped LuaJIT 2.1 dump for `return 1`. */
export const LUAJIT_RETURN_ONE_DUMP = Buffer.from(
  "1b4c4a02020f00000100000002290001004c00020000",
  "hex",
);

/** Builds a one-asset archive containing `payload` of the given type id. */
export function buildArchive(payload: Uint8Array, typeId = UNIT_TYPE, fileId = SAMPLE_FILE_ID): Uint8Array {
  return buildArchiveFromAssets([{ payload, typeId, fileId }]);
}

/** Builds an archive with one TOC entry per asset, grouped into a type table. */
export function buildArchiveFromAssets(
  assets: Array<{ payload: Uint8Array; typeId?: bigint; fileId?: bigint }>,
): Uint8Array {
  const resolved = assets.map((asset, index) => ({
    payload: asset.payload,
    typeId: asset.typeId ?? UNIT_TYPE,
    fileId: asset.fileId ?? SAMPLE_FILE_ID + BigInt(index),
  }));
  const typeCounts = new Map<bigint, number>();
  for (const asset of resolved) {
    typeCounts.set(asset.typeId, (typeCounts.get(asset.typeId) ?? 0) + 1);
  }
  const typeList = [...typeCounts.entries()];
  const toc = ARCHIVE_HEADER_SIZE + typeList.length * GAME_ASSET_TYPE_SIZE + resolved.length * GAME_ASSET_HEADER_SIZE;
  const data = new Uint8Array(toc + resolved.reduce((total, asset) => total + asset.payload.length, 0));

  writeU32(data, 0, ARCHIVE_MAGIC);
  writeU32(data, 4, typeList.length);
  writeU32(data, 8, resolved.length);

  let typeOffset = ARCHIVE_HEADER_SIZE;
  for (const [typeId, count] of typeList) {
    writeU64(data, typeOffset + 8, typeId);
    writeU32(data, typeOffset + 16, count);
    writeU32(data, typeOffset + 24, 16);
    writeU32(data, typeOffset + 28, 64);
    typeOffset += GAME_ASSET_TYPE_SIZE;
  }

  let headerOffset = ARCHIVE_HEADER_SIZE + typeList.length * GAME_ASSET_TYPE_SIZE;
  let dataOffset = toc;
  let entryIndex = 1;
  for (const asset of resolved) {
    writeU64(data, headerOffset, asset.fileId);
    writeU64(data, headerOffset + 8, asset.typeId);
    writeU64(data, headerOffset + 16, BigInt(dataOffset));
    writeU32(data, headerOffset + 56, asset.payload.length);
    writeU32(data, headerOffset + 76, entryIndex);
    data.set(asset.payload, dataOffset);
    dataOffset += asset.payload.length;
    headerOffset += GAME_ASSET_HEADER_SIZE;
    entryIndex += 1;
  }

  return data;
}

/** Shared temp root for steps that need files. Isolated per `npm run check` run. */
export class TestWorkspace {
  tempDir = "";

  async setup(): Promise<void> {
    this.tempDir = await mkdtemp(path.join(tmpdir(), "library-validator-"));
    console.log("temp", this.tempDir);
  }

  async cleanup(): Promise<void> {
    if (this.tempDir) {
      await rm(this.tempDir, { recursive: true, force: true });
    }
  }

  async createDir(name: string): Promise<string> {
    const dir = path.join(this.tempDir, name);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async writeFile(dir: string, name: string, data: Uint8Array): Promise<string> {
    const filePath = path.join(dir, name);
    await writeFile(filePath, data);
    return filePath;
  }
}

export const workspace = new TestWorkspace();
