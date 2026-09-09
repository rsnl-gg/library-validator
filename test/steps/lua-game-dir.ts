import assert from "node:assert/strict";
import { hasLuaScript } from "../../src/index.js";
import { buildArchive, buildLuaPayload, LUA_TYPE, workspace } from "../fixtures.js";
import { addTestStep } from "../harness.js";

addTestStep("hasLuaScript game dir", async () => {
  const gameDir = await workspace.createDir("lua-dir");
  await workspace.writeFile(
    gameDir,
    "script.patch_0",
    buildArchive(buildLuaPayload("return { ok = true }\n"), LUA_TYPE),
  );

  const result = await hasLuaScript(gameDir);
  assert.equal(result.found, true);
  assert.deepEqual(result.extractedPaths, []);
  return result;
});
