import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { hasLuaScript } from "../../src/index.js";
import {
  buildArchive,
  buildLuaPayloadFromBytes,
  LUAJIT_RETURN_ONE_DUMP,
  LUA_TYPE,
  SAMPLE_FILE_ID_HEX,
  workspace,
} from "../fixtures.js";
import { addTestStep } from "../harness.js";

addTestStep("hasLuaScript extract luajit bytecode", async () => {
  const gameDir = await workspace.createDir("lua-extract-bc");
  const patchPath = await workspace.writeFile(
    gameDir,
    "script.patch_0",
    buildArchive(buildLuaPayloadFromBytes(LUAJIT_RETURN_ONE_DUMP), LUA_TYPE),
  );

  const extracted = await hasLuaScript(patchPath, true);
  const extractedPath = path.join(gameDir, `${SAMPLE_FILE_ID_HEX}.lua`);
  const extractedSource = await readFile(extractedPath, "utf8");
  assert.equal(extracted.found, true);
  assert.deepEqual(extracted.extractedPaths, [extractedPath]);
  assert.equal(extractedSource.includes("\u0000"), false);
  assert.match(extractedSource, /v0 = 1/);
  assert.match(extractedSource, /return v0/);
  return { extracted, path: extractedPath, source: extractedSource.trim() };
});
