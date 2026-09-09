import assert from "node:assert/strict";
import { checkUnitCompatibility } from "../../src/index.js";
import { buildArchive, TEXTURE_TYPE, workspace } from "../fixtures.js";
import { addTestStep } from "../harness.js";

addTestStep("unit no-unit", async () => {
  const gameDir = await workspace.createDir("no-unit");
  const patchPath = await workspace.writeFile(
    gameDir,
    "texture.patch_0",
    buildArchive(new Uint8Array(8), TEXTURE_TYPE),
  );

  const result = await checkUnitCompatibility(patchPath, gameDir);
  assert.equal(result.compatible, false);
  assert.equal(result.reason, "no-unit");
  assert.equal(result.patchVersion, undefined);
  return result;
});
