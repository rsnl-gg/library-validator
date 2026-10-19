import assert from "node:assert/strict";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { checkUnitCompatibility, hasLuaScript, UnitChecker } from "../../src/index.js";
import { DSAR_MAGIC } from "../../src/core/binary.js";
import { PatchToc, toPatchBackupPath as toBackup } from "../../src/stingray/archive.js";
import {
  buildArchive,
  buildArchiveFromAssets,
  buildLuaPayload,
  buildRepairUnitPayload,
  LUA_TYPE,
  SAMPLE_FILE_ID,
  TEXTURE_TYPE,
  workspace,
} from "../fixtures.js";
import { addTestStep } from "../harness.js";

const GAME_VERSION = 0x34;
const PATCH_VERSION = 0x35;
const GAME_LOD = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const PATCH_LOD = Uint8Array.from([9, 9, 9, 9]);

/** Wraps archive bytes in an uncompressed DSAR container split into chunks of `chunkSize`. */
function buildDsar(archive: Uint8Array, chunkSize = 64): Uint8Array {
  const chunkCount = Math.ceil(archive.length / chunkSize);
  const tableSize = 32 + chunkCount * 32;
  const out = new Uint8Array(tableSize + archive.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, DSAR_MAGIC, true);
  view.setUint32(8, chunkCount, true);
  view.setUint32(12, tableSize, true);
  view.setBigUint64(16, BigInt(archive.length), true);
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const size = Math.min(chunkSize, archive.length - start);
    const row = 32 + i * 32;
    view.setBigUint64(row, BigInt(start), true);
    view.setBigUint64(row + 8, BigInt(tableSize + start), true);
    view.setUint32(row + 16, size, true);
    view.setUint32(row + 20, size, true);
    out[row + 24] = 0;
  }
  out.set(archive, tableSize);
  return out;
}

addTestStep("UnitChecker reused across patches matches checkUnitCompatibility byte for byte", async () => {
  const checkerDir = await workspace.createDir("checker-reuse");
  const batchDir = await workspace.createDir("checker-reuse-batch");
  const gameArchiveId = "aabbccddeeff0031";
  const game = buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD));
  const patches = [
    { name: `${gameArchiveId}.patch_0`, bytes: buildArchive(buildRepairUnitPayload(PATCH_VERSION, PATCH_LOD)) },
    { name: `${gameArchiveId}.patch_1`, bytes: buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD)) },
    { name: `${gameArchiveId}.patch_2`, bytes: buildArchive(buildLuaPayload("return 1"), LUA_TYPE) },
  ];
  for (const dir of [checkerDir, batchDir]) {
    await workspace.writeFile(dir, gameArchiveId, game);
    for (const patch of patches) {
      await workspace.writeFile(dir, patch.name, patch.bytes);
    }
  }

  const checker = await UnitChecker.open(checkerDir);
  const viaChecker = [];
  try {
    for (const patch of patches) {
      viaChecker.push(await checker.check(path.join(checkerDir, patch.name), { repair: true }));
    }
  } finally {
    await checker.close();
  }
  const viaBatch = await checkUnitCompatibility(
    patches.map((patch) => path.join(batchDir, patch.name)),
    batchDir,
    { repair: true },
  );

  assert.deepEqual(viaChecker, viaBatch);
  assert.equal(viaChecker[0].repaired, true);
  assert.equal(viaChecker[1].compatible, true);
  assert.equal(viaChecker[2].reason, "no-unit");
  for (const name of [...patches.map((patch) => patch.name), `${gameArchiveId}.backup_0`]) {
    assert.deepEqual(
      new Uint8Array(await readFile(path.join(checkerDir, name))),
      new Uint8Array(await readFile(path.join(batchDir, name))),
      `${name} differs`,
    );
  }
  return viaChecker;
});

addTestStep("UnitChecker reports stale game data after a change", async () => {
  const gameDir = await workspace.createDir("checker-stale");
  const archiveId = "aabbccddeeff0032";
  await workspace.writeFile(gameDir, archiveId, buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD)));
  const checker = await UnitChecker.open(gameDir);
  try {
    assert.equal(await checker.isStale(), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await copyFile(path.join(gameDir, archiveId), path.join(gameDir, "aabbccddeeff0033"));
    assert.equal(await checker.isStale(), true);
  } finally {
    await checker.close();
  }
  return { stale: true };
});

addTestStep("unit check on a DSAR patch reads ranges and never repairs it", async () => {
  const gameDir = await workspace.createDir("checker-dsar");
  const archiveId = "aabbccddeeff0034";
  await workspace.writeFile(gameDir, archiveId, buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD)));
  const dsarBytes = buildDsar(
    buildArchiveFromAssets([
      { payload: new Uint8Array(500), typeId: TEXTURE_TYPE, fileId: SAMPLE_FILE_ID + 7n },
      { payload: buildRepairUnitPayload(PATCH_VERSION, PATCH_LOD), fileId: SAMPLE_FILE_ID },
    ]),
  );
  const patchPath = await workspace.writeFile(gameDir, `${archiveId}.patch_0`, dsarBytes);

  const toc = await PatchToc.open(patchPath);
  try {
    assert.equal(toc.compressed, true);
    assert.equal(toc.assets.length, 2);
  } finally {
    await toc.close();
  }

  const result = await checkUnitCompatibility(patchPath, gameDir, { repair: true });
  assert.equal(result.reason, "version-mismatch");
  assert.equal(result.patchVersion, PATCH_VERSION);
  assert.equal(result.repaired, undefined);
  assert.deepEqual(new Uint8Array(await readFile(patchPath)), dsarBytes);
  return result;
});

addTestStep("hasLuaScript extracts from a DSAR patch", async () => {
  const dir = await workspace.createDir("lua-dsar");
  await workspace.writeFile(
    dir,
    "aabbccddeeff0035.patch_0",
    buildDsar(
      buildArchiveFromAssets([
        { payload: new Uint8Array(300), typeId: TEXTURE_TYPE, fileId: SAMPLE_FILE_ID + 3n },
        { payload: buildLuaPayload("return { dsar = true }"), typeId: LUA_TYPE, fileId: SAMPLE_FILE_ID },
      ]),
    ),
  );
  const result = await hasLuaScript(dir, true);
  assert.equal(result.found, true);
  assert.equal(result.extractedPaths.length, 1);
  assert.equal(await readFile(result.extractedPaths[0], "utf8"), "return { dsar = true }");
  return result;
});

addTestStep("unit check treats a unit outside the archive as no-unit", async () => {
  const gameDir = await workspace.createDir("checker-truncated");
  const archiveId = "aabbccddeeff0036";
  await workspace.writeFile(gameDir, archiveId, buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD)));
  const bytes = buildArchive(buildRepairUnitPayload(PATCH_VERSION, PATCH_LOD));
  const patchPath = await workspace.writeFile(gameDir, `${archiveId}.patch_0`, bytes.subarray(0, bytes.length - 4));

  const result = await checkUnitCompatibility(patchPath, gameDir, { repair: true });
  assert.deepEqual(result, { compatible: false, reason: "no-unit" });
  return result;
});

addTestStep("unit repair is redone from the original backup after a game update", async () => {
  const gameDir = await workspace.createDir("repair-after-update");
  const freshDir = await workspace.createDir("repair-after-update-fresh");
  const archiveId = "aabbccddeeff0037";
  const UPDATED_VERSION = 0x36;
  const UPDATED_LOD = Uint8Array.from([4, 4, 4, 4, 4, 4]);
  const originalBytes = buildArchive(buildRepairUnitPayload(PATCH_VERSION, PATCH_LOD));
  const patchPath = await workspace.writeFile(gameDir, `${archiveId}.patch_0`, originalBytes);
  await workspace.writeFile(gameDir, archiveId, buildArchive(buildRepairUnitPayload(GAME_VERSION, GAME_LOD)));

  const first = await checkUnitCompatibility(patchPath, gameDir, { repair: true });
  assert.equal(first.repaired, true);
  assert.equal(first.patchVersion, GAME_VERSION);

  // Game update: new unit version and LOD group, the repaired patch is outdated again
  const updatedGame = buildArchive(buildRepairUnitPayload(UPDATED_VERSION, UPDATED_LOD));
  await workspace.writeFile(gameDir, archiveId, updatedGame);
  const second = await checkUnitCompatibility(patchPath, gameDir, { repair: true });
  assert.equal(second.compatible, true);
  assert.equal(second.repaired, true);
  assert.equal(second.patchVersion, UPDATED_VERSION);
  assert.deepEqual(new Uint8Array(await readFile(toBackup(patchPath))), originalBytes, "backup untouched");

  // Same bytes as repairing the original file against the updated game for the first time
  const freshPatch = await workspace.writeFile(freshDir, `${archiveId}.patch_0`, originalBytes);
  await workspace.writeFile(freshDir, archiveId, updatedGame);
  await checkUnitCompatibility(freshPatch, freshDir, { repair: true });
  assert.deepEqual(new Uint8Array(await readFile(patchPath)), new Uint8Array(await readFile(freshPatch)));

  const third = await checkUnitCompatibility(patchPath, gameDir, { repair: true });
  assert.equal(third.compatible, true);
  assert.equal(third.repaired, undefined);
  return second;
});
