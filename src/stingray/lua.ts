export const LUA_TYPE_ID = "a14e8dfa2cd117e2";
export const LUA_HEADER_SIZE = 8;

/**
 * Strips the 8-byte Stingray Lua header and returns the source bytes.
 * If the header does not match the payload length, the original buffer is returned.
 * @param data - Raw Lua asset payload as `Uint8Array`.
 * @returns Lua source as `Uint8Array`.
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
