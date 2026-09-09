import assert from "node:assert/strict";
import { checkUnitCompatibility } from "../../src/index.js";
import { buildArchive, buildUnitPayload, workspace } from "../fixtures.js";
import { addTestStep } from "../harness.js";

addTestStep("unit version-mismatch", async () => {
  const gameDir = await workspace.createDir("mismatch");
  const archiveId = "aabbccddeeff0011";
  const patchPath = await workspace.writeFile(
    gameDir,
    `${archiveId}.patch_0`,
    buildArchive(buildUnitPayload(0x35)),
  );
  await workspace.writeFile(gameDir, archiveId, buildArchive(buildUnitPayload(0x34)));

  const result = await checkUnitCompatibility(patchPath, gameDir);
  assert.equal(result.patchVersion, 0x35);
  assert.equal(result.archiveVersion, 0x34);
  assert.equal(result.compatible, false);
  assert.equal(result.reason, "version-mismatch");
  return result;
});
