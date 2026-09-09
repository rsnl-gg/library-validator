import assert from "node:assert/strict";
import { checkUnitCompatibility } from "../../src/index.js";
import { buildArchive, buildUnitPayload, workspace } from "../fixtures.js";
import { addTestStep } from "../harness.js";

addTestStep("unit compatible", async () => {
  const gameDir = await workspace.createDir("compatible");
  const archiveId = "aabbccddeeff0011";
  const patchPath = await workspace.writeFile(
    gameDir,
    `${archiveId}.patch_0`,
    buildArchive(buildUnitPayload(0x35)),
  );
  await workspace.writeFile(gameDir, archiveId, buildArchive(buildUnitPayload(0x35)));

  const result = await checkUnitCompatibility(patchPath, gameDir);
  assert.equal(result.patchVersion, 0x35);
  assert.equal(result.archiveVersion, 0x35);
  assert.equal(result.compatible, true);
  assert.equal(result.reason, undefined);
  return result;
});
