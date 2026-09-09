import assert from "node:assert/strict";
import { hasLuaScript } from "../../src/index.js";
import { workspace } from "../fixtures.js";
import { addTestStep } from "../harness.js";

addTestStep("hasLuaScript companion file", async () => {
  const gameDir = await workspace.createDir("lua-companion");
  const companion = await workspace.writeFile(
    gameDir,
    "script.patch_0.gpu_resources",
    new Uint8Array(0),
  );

  const result = await hasLuaScript(companion);
  assert.equal(result.found, false);
  assert.deepEqual(result.extractedPaths, []);
  return result;
});
