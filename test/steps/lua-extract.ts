import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { hasLuaScript } from "../../src/index.js";
import {
  buildArchive,
  buildLuaPayload,
  LUA_TYPE,
  SAMPLE_FILE_ID_HEX,
  workspace,
} from "../fixtures.js";
import { addTestStep } from "../harness.js";

addTestStep("hasLuaScript extract", async () => {
  const luaSource = "return { ok = true }\n";
  const gameDir = await workspace.createDir("lua-extract");
  const patchPath = await workspace.writeFile(
    gameDir,
    "script.patch_0",
    buildArchive(buildLuaPayload(luaSource), LUA_TYPE),
  );

  const extracted = await hasLuaScript(patchPath, true);
  const extractedPath = path.join(gameDir, `${SAMPLE_FILE_ID_HEX}.lua`);
  const extractedSource = await readFile(extractedPath, "utf8");
  assert.equal(extracted.found, true);
  assert.deepEqual(extracted.extractedPaths, [extractedPath]);
  assert.equal(extractedSource, luaSource);
  return { extracted, path: extractedPath, source: extractedSource.trim() };
});
