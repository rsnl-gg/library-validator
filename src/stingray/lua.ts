import { decompileLuaJit, isLuaJitDump } from "./luajit.js";

export const LUA_TYPE_ID = "a14e8dfa2cd117e2";
export const LUA_HEADER_SIZE = 8;

/**
 * Strips the 8-byte Stingray Lua header and returns the payload bytes.
 * The payload is either UTF-8 Lua source or a LuaJIT bytecode dump.
 * If the header does not match the payload length, the original buffer is returned.
 * @param data - Raw Lua asset payload as `Uint8Array`.
 * @returns Lua payload as `Uint8Array`.
 */
export function readLuaSource(data: Uint8Array): Uint8Array {
  if (data.length < LUA_HEADER_SIZE) {
    return data;
  }
  const bodySize = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
  if (bodySize + LUA_HEADER_SIZE === data.length) {
    return data.subarray(LUA_HEADER_SIZE);
  }
  return data;
}

/**
 * Turns a Lua asset payload into UTF-8 Lua source.
 * LuaJIT bytecode dumps are decompiled; already-readable source is decoded as UTF-8.
 * @param data - Raw Lua asset payload as `Uint8Array`.
 * @returns Lua source as `string`.
 */
export function decodeLuaAsset(data: Uint8Array): string {
  const body = readLuaSource(data);
  if (isLuaJitDump(body)) {
    return decompileLuaJit(body);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(body);
}
