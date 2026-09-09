import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pkgPath = resolve(root, "package.json");

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args) {
  const bin = command === "npm" ? npmBin() : command;
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(bin, args, { stdio: "inherit", cwd: root });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function git(args) {
  return spawnSync("git", args, { encoding: "utf8", cwd: root });
}

function calverThisMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    return null;
  }
  return { year: Number(match[1]), month: Number(match[2]), iteration: Number(match[3]) };
}

function tagExists(version) {
  const result = git(["rev-parse", `v${version}`]);
  return result.status === 0;
}

function suggestedVersion(localVersion) {
  const { year, month } = calverThisMonth();
  const parsed = parseVersion(localVersion);
  if (parsed && parsed.year === year && parsed.month === month) {
    if (tagExists(localVersion)) {
      return `${year}.${month}.${parsed.iteration + 1}`;
    }
    return localVersion;
  }
  return `${year}.${month}.1`;
}

async function askVersion(suggested) {
  const fromArg = process.argv[2]?.trim();
  if (fromArg) {
    return fromArg;
  }
  if (!input.isTTY) {
    console.error("Pass the version as an argument: npm run release -- 2026.9.1");
    process.exit(1);
  }

  const rl = createInterface({ input, output });
  try {
    const answer = (
      await rl.question(
        `CalVer is {year}.{month}.{iteration}, with iteration 1 on the first publish of the month.\nVersion to publish [${suggested}]: `,
      )
    ).trim();
    return answer || suggested;
  } finally {
    rl.close();
  }
}

function assertGitReady() {
  const repo = git(["rev-parse", "--is-inside-work-tree"]);
  if (repo.status !== 0) {
    console.error("Initialize a git repository and add a remote before releasing.");
    process.exit(1);
  }

  const dirty = git(["status", "--porcelain"]);
  if (dirty.stdout.trim()) {
    console.error("Working tree is not clean. Commit or stash changes before releasing.");
    process.exit(1);
  }

  const remote = git(["remote"]);
  if (!remote.stdout.trim()) {
    console.error("No git remote configured. Add one before releasing.");
    process.exit(1);
  }
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
assertGitReady();

const version = await askVersion(suggestedVersion(pkg.version));
if (!parseVersion(version)) {
  console.error(`Invalid version "${version}". Use {year}.{month}.{iteration} such as 2026.9.1.`);
  process.exit(1);
}

run("npm", ["version", version, "--allow-same-version", "-m", "chore: release v%s"]);
run("npm", ["publish"]);
