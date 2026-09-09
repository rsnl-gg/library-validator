import assert from "node:assert/strict";
import { hasLuaScript } from "../../src/index.js";
import { workspace } from "../fixtures.js";
import { addTestStep } from "../harness.js";

addTestStep("hasLuaScript empty dir", async () => {
  const emptyDir = await workspace.createDir("empty");
  const result = await hasLuaScript(emptyDir);
  assert.equal(result.found, false);
  assert.deepEqual(result.extractedPaths, []);
  return result;
});
