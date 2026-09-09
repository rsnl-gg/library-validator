import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8"));
const tag = `v${pkg.version}`;

const which = spawnSync("gh", ["--version"], { stdio: "ignore" });
if (which.status !== 0) {
  console.error(
    "ERROR: GitHub CLI ('gh') is not installed or not on PATH.\n" +
      "Install it from https://cli.github.com/ and run `gh auth login` once.",
  );
  process.exit(1);
}

console.log(`> gh release create ${tag} --generate-notes --title ${tag}`);
const result = spawnSync("gh", ["release", "create", tag, "--generate-notes", "--title", tag], {
  stdio: "inherit",
});

if (result.status !== 0) {
  console.error(`gh release create exited with code ${result.status ?? "null"}.`);
  process.exit(result.status ?? 1);
}
