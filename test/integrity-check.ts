import { workspace } from "./fixtures.js";
import { runTestSteps } from "./harness.js";
import "./steps/index.js";

async function main(): Promise<void> {
  console.log("library-validator integrity check\n");
  try {
    await workspace.setup();
    const passed = await runTestSteps();
    if (!passed) {
      process.exitCode = 1;
      return;
    }
    console.log("\nintegrity check passed");
  } finally {
    await workspace.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
