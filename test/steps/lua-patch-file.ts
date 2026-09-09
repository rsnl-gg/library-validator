import assert from "node:assert/strict";
import { hasLuaScript } from "../../src/index.js";
import { buildArchive, buildLuaPayload, LUA_TYPE, workspace } from "../fixtures.js";
import { addTestStep } from "../harness.js";

addTestStep("hasLuaScript lua patch", async () => {
  const gameDir = await workspace.createDir("lua-patch");
  const patchPath = await workspace.writeFile(
    gameDir,
    "script.patch_0",
    buildArchive(buildLuaPayload("return { ok = true }\n"), LUA_TYPE),
  );

  const result = await hasLuaScript(patchPath);
  assert.equal(result.found, true);
  assert.deepEqual(result.extractedPaths, []);
  return result;
});
