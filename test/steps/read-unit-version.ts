import assert from "node:assert/strict";
import { readUnitVersion } from "../../src/stingray/unit.js";
import { buildUnitPayload } from "../fixtures.js";
import { addTestStep } from "../harness.js";

addTestStep("readUnitVersion", () => {
  const version = 0x35;
  assert.equal(readUnitVersion(buildUnitPayload(version)), version);
  return { version };
});
