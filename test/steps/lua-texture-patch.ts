import assert from "node:assert/strict";
import { hasLuaScript } from "../../src/index.js";
import { buildArchive, TEXTURE_TYPE, workspace } from "../fixtures.js";
import { addTestStep } from "../harness.js";

addTestStep("hasLuaScript texture patch", async () => {
  const gameDir = await workspace.createDir("lua-texture");
  const patchPath = await workspace.writeFile(
    gameDir,
    "texture.patch_0",
    buildArchive(new Uint8Array(8), TEXTURE_TYPE),
  );

  const result = await hasLuaScript(patchPath);
  assert.equal(result, false);
  return result;
});
