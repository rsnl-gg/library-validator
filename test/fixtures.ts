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

/** Builds a Stingray Lua asset payload with an 8-byte header plus UTF-8 source. */
export function buildLuaPayload(source: string): Uint8Array {
  const body = Buffer.from(source, "utf8");
  const payload = new Uint8Array(8 + body.length);
  writeU32(payload, 0, body.length);
  writeU32(payload, 4, 2);
  payload.set(body, 8);
  return payload;
}

/** Builds a one-asset archive containing `payload` of the given type id. */
export function buildArchive(payload: Uint8Array, typeId = UNIT_TYPE): Uint8Array {
  const toc = ARCHIVE_HEADER_SIZE + GAME_ASSET_TYPE_SIZE + GAME_ASSET_HEADER_SIZE;
  const data = new Uint8Array(toc + payload.length);

  writeU32(data, 0, ARCHIVE_MAGIC);
  writeU32(data, 4, 1);
  writeU32(data, 8, 1);
  writeU64(data, 80, typeId);
  writeU32(data, 88, 1);
  writeU32(data, 96, 16);
  writeU32(data, 100, 64);
  writeU64(data, 104, SAMPLE_FILE_ID);
  writeU64(data, 112, typeId);
  writeU64(data, 120, BigInt(toc));
  writeU32(data, 160, payload.length);
  writeU32(data, 180, 1);
  data.set(payload, toc);
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
