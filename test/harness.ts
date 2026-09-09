type TestStep = {
  name: string;
  run: () => Promise<unknown> | unknown;
};

const steps: TestStep[] = [];

/**
 * Registers a named integrity-check step to run later.
 * @param name - Step label printed on success as `string`.
 * @param run - Step body. Return a value to include it in the log.
 */
export function addTestStep(name: string, run: TestStep["run"]): void {
  steps.push({ name, run });
}

function stepTag(index: number, total: number): string {
  const width = Math.max(2, String(total).length);
  return `${String(index + 1).padStart(width, "0")}/${String(total).padStart(width, "0")}`;
}

function logStep(status: "ok" | "fail" | "skip", index: number, total: number, name: string, detail?: unknown): void {
  const line = `[${stepTag(index, total)}] [${status.padEnd(status.length).toUpperCase()}] ${name}:`;
  if (status === "fail") {
    console.error(line);
    return;
  }
  if (detail === undefined) {
    console.log(line);
    return;
  }
  console.log(line, detail);
}

/**
 * Runs every registered step in registration order.
 * On failure the remaining steps are skipped and the function returns false.
 * @returns Promise resolving to `boolean`: true if every step passed.
 */
export async function runTestSteps(): Promise<boolean> {
  const total = steps.length;

  for (let index = 0; index < total; index++) {
    const step = steps[index];
    try {
      const detail = await step.run();
      logStep("ok", index, total, step.name, detail);
    } catch (error) {
      logStep("fail", index, total, step.name);
      console.error(error);
      for (let skipped = index + 1; skipped < total; skipped++) {
        logStep("skip", skipped, total, steps[skipped].name);
      }
      console.error(`\nintegrity check failed at step ${stepTag(index, total)}`);
      return false;
    }
  }

  return true;
}
