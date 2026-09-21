import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { checkUnitCompatibility } from "../../src/index.js";
import { replaceWithBackup } from "../../src/core/io.js";
import { Archive, toPatchBackupPath } from "../../src/stingray/archive.js";
import { readUnitVersion, UNIT_LAYOUT_LIST_OFFSET, UNIT_TYPE_ID } from "../../src/stingray/unit.js";
import {
  buildArchive,
  buildArchiveFromAssets,
  buildLayoutUnitPayload,
  buildRepairUnitPayload,
  SAMPLE_FILE_ID,
  SAMPLE_FILE_ID_HEX,
  TEXTURE_TYPE,
  workspace,
} from "../fixtures.js";
import { addTestStep } from "../harness.js";

const GAME_VERSION = 0x34;
const PATCH_VERSION = 0x35;
const GAME_LOD = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const PATCH_LOD = Uint8Array.from([9, 9, 9, 9]);

addTestStep("unit version-mismatch left unchanged without repair", async () => {
  const gameDir = await workspace.createDir("mismatch-no-repair");
  const archiveId = "aabbccddeeff0021";
  const patchBytes = buildArchive(buildRepairUnitPayload(PATCH_VERSION, PATCH_LOD));
  const patchPath = await workspace.writeFile(gameDir, `${archiveId}.patch_0`, patchBytes);
  await workspace.writeFile(gameDir, archiveId, buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD)));

  const result = await checkUnitCompatibility(patchPath, gameDir);
  const after = new Uint8Array(await readFile(patchPath));

  assert.equal(result.compatible, false);
  assert.equal(result.reason, "version-mismatch");
  assert.equal(result.repaired, undefined);
  assert.deepEqual(after, patchBytes);
  return result;
});

addTestStep("unit version-mismatch repaired beside a backup", async () => {
  const gameDir = await workspace.createDir("mismatch-repair");
  const archiveId = "aabbccddeeff0022";
  const originalBytes = buildArchive(buildRepairUnitPayload(PATCH_VERSION, PATCH_LOD));
  const patchPath = await workspace.writeFile(gameDir, `${archiveId}.patch_0`, originalBytes);
  await workspace.writeFile(gameDir, archiveId, buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD)));

  const result = await checkUnitCompatibility(patchPath, gameDir, { repair: true });
  assert.equal(result.compatible, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.repaired, true);
  assert.equal(result.patchVersion, GAME_VERSION);
  assert.equal(result.archiveVersion, GAME_VERSION);

  const backupPath = toPatchBackupPath(patchPath);
  await access(backupPath);
  assert.deepEqual(new Uint8Array(await readFile(backupPath)), originalBytes);

  const again = await checkUnitCompatibility(patchPath, gameDir);
  assert.equal(again.compatible, true);
  assert.equal(again.repaired, undefined);

  const repaired = await Archive.open(patchPath);
  const unit = repaired.assetsOf(UNIT_TYPE_ID)[0];
  const payload = repaired.read(unit);
  assert.equal(readUnitVersion(payload), GAME_VERSION);
  assert.deepEqual(payload.subarray(payload.length - GAME_LOD.length), GAME_LOD);
  return result;
});

addTestStep("unit compatible is not rewritten when repair is enabled", async () => {
  const gameDir = await workspace.createDir("compatible-repair");
  const archiveId = "aabbccddeeff0023";
  const bytes = buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD));
  const patchPath = await workspace.writeFile(gameDir, `${archiveId}.patch_0`, bytes);
  await workspace.writeFile(gameDir, archiveId, bytes);

  const result = await checkUnitCompatibility(patchPath, gameDir, { repair: true });
  const after = new Uint8Array(await readFile(patchPath));
  assert.equal(result.compatible, true);
  assert.equal(result.repaired, undefined);
  assert.deepEqual(after, bytes);
  return result;
});

addTestStep("unit version-mismatch repair drops units missing from game data", async () => {
  const gameDir = await workspace.createDir("mismatch-orphan");
  const archiveId = "aabbccddeeff0024";
  const missingId = SAMPLE_FILE_ID + 1n;
  const patchPath = await workspace.writeFile(
    gameDir,
    `${archiveId}.patch_0`,
    buildArchiveFromAssets([
      { payload: buildRepairUnitPayload(PATCH_VERSION, PATCH_LOD), fileId: SAMPLE_FILE_ID },
      { payload: buildRepairUnitPayload(PATCH_VERSION, PATCH_LOD), fileId: missingId },
    ]),
  );
  await workspace.writeFile(
    gameDir,
    archiveId,
    buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD), undefined, SAMPLE_FILE_ID),
  );

  const result = await checkUnitCompatibility(patchPath, gameDir, { repair: true });
  assert.equal(result.compatible, true);
  assert.equal(result.repaired, true);

  const repaired = await Archive.open(patchPath);
  const units = repaired.assetsOf(UNIT_TYPE_ID);
  assert.equal(units.length, 1);
  assert.equal(units[0].fileId, SAMPLE_FILE_ID_HEX);
  assert.equal(readUnitVersion(repaired.read(units[0])), GAME_VERSION);
  return result;
});

addTestStep("unit version-mismatch repair migrates old vertex layout formats", async () => {
  const gameDir = await workspace.createDir("mismatch-layout");
  const archiveId = "aabbccddeeff0025";
  const patchPath = await workspace.writeFile(
    gameDir,
    `${archiveId}.patch_0`,
    buildArchive(buildLayoutUnitPayload(0x10, PATCH_LOD, 20)),
  );
  await workspace.writeFile(gameDir, archiveId, buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD)));

  const result = await checkUnitCompatibility(patchPath, gameDir, { repair: true });
  assert.equal(result.compatible, true);
  assert.equal(result.repaired, true);

  const repaired = await Archive.open(patchPath);
  const payload = repaired.read(repaired.assetsOf(UNIT_TYPE_ID)[0]);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const layoutListOffset = view.getUint32(UNIT_LAYOUT_LIST_OFFSET, true);
  const itemFormat = view.getUint32(layoutListOffset + 16 + 4, true);
  assert.equal(itemFormat, 24);
  return result;
});

addTestStep("unit check accepts a patch array and repairs only mismatches", async () => {
  const gameDir = await workspace.createDir("batch-repair");
  const archiveId = "aabbccddeeff0026";
  const mismatchPath = await workspace.writeFile(
    gameDir,
    `${archiveId}.patch_0`,
    buildArchive(buildRepairUnitPayload(PATCH_VERSION, PATCH_LOD)),
  );
  const compatibleBytes = buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD));
  const compatiblePath = await workspace.writeFile(gameDir, `${archiveId}.patch_1`, compatibleBytes);
  const noUnitPath = await workspace.writeFile(
    gameDir,
    `${archiveId}.patch_2`,
    buildArchive(new Uint8Array(8), TEXTURE_TYPE),
  );
  await workspace.writeFile(gameDir, archiveId, buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD)));

  const empty = await checkUnitCompatibility([], gameDir, { repair: true });
  assert.deepEqual(empty, []);

  const progress: Array<{ current: number; total: number; name: string }> = [];
  const results = await checkUnitCompatibility(
    [mismatchPath, compatiblePath, noUnitPath],
    gameDir,
    {
      repair: true,
      onPatchProgress: (current, total, name) => progress.push({ current, total, name }),
    },
  );
  assert.equal(progress.length, 3);
  assert.equal(progress[0].current, 1);
  assert.equal(progress[2].current, 3);
  assert.equal(progress[2].total, 3);
  assert.equal(results.length, 3);
  assert.equal(results[0].compatible, true);
  assert.equal(results[0].repaired, true);
  assert.equal(results[1].compatible, true);
  assert.equal(results[1].repaired, undefined);
  assert.equal(results[2].compatible, false);
  assert.equal(results[2].reason, "no-unit");
  assert.deepEqual(new Uint8Array(await readFile(compatiblePath)), compatibleBytes);
  assert.equal(existsSync(toPatchBackupPath(mismatchPath)), true);
  assert.equal(existsSync(toPatchBackupPath(compatiblePath)), false);
  return results;
});

addTestStep("replaceWithBackup restores the original patch name if writing fails", async () => {
  const dir = await workspace.createDir("backup-restore");
  const original = Uint8Array.from([1, 2, 3, 4]);
  const patchPath = await workspace.writeFile(dir, "aabbccddeeff0027.patch_0", original);
  const backupPath = toPatchBackupPath(patchPath);

  await assert.rejects(
    replaceWithBackup(patchPath, backupPath, Uint8Array.from([9, 9]), async () => {
      throw new Error("write failed");
    }),
    /write failed/,
  );

  assert.equal(existsSync(backupPath), false);
  assert.deepEqual(new Uint8Array(await readFile(patchPath)), original);
  return { restored: true };
});

addTestStep("unit repair leaves the original patch when a backup already exists", async () => {
  const gameDir = await workspace.createDir("backup-exists");
  const archiveId = "aabbccddeeff0028";
  const originalBytes = buildArchive(buildRepairUnitPayload(PATCH_VERSION, PATCH_LOD));
  const patchPath = await workspace.writeFile(gameDir, `${archiveId}.patch_0`, originalBytes);
  await workspace.writeFile(gameDir, `${archiveId}.backup_0`, Uint8Array.from([7, 7, 7]));
  await workspace.writeFile(gameDir, archiveId, buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD)));

  const result = await checkUnitCompatibility(patchPath, gameDir, { repair: true });
  assert.equal(result.compatible, false);
  assert.equal(result.reason, "version-mismatch");
  assert.equal(result.repaired, true);
  assert.deepEqual(new Uint8Array(await readFile(patchPath)), originalBytes);
  assert.deepEqual(new Uint8Array(await readFile(toPatchBackupPath(patchPath))), Uint8Array.from([7, 7, 7]));
  return result;
});
