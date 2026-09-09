import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pkgPath = resolve(root, "package.json");

function quoteCmd(arg) {
  if (!/[\s"&()<>^|%]/.test(arg)) {
    return arg;
  }
  return `"${arg.replaceAll('"', '""')}"`;
}

function run(command, args = []) {
  const line = [command, ...args.map(quoteCmd)].join(" ");
  console.log(`> ${line}`);
  try {
    execSync(line, { stdio: "inherit", cwd: root, env: process.env });
  } catch {
    process.exit(1);
  }
}

function git(args) {
  return spawnSync("git", args, { encoding: "utf8", cwd: root });
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    return null;
  }
  return { year: Number(match[1]), month: Number(match[2]), iteration: Number(match[3]) };
}

function calverThisMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function hasRef(ref) {
  return git(["rev-parse", "--verify", "--quiet", ref]).status === 0;
}

function tagExists(version) {
  return hasRef(`refs/tags/v${version}`) || hasRef(`refs/tags/${version}`);
}

function npmHasVersion(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    encoding: "utf8",
    cwd: root,
    shell: true,
  });
  return result.status === 0 && result.stdout.trim() === version;
}

function suggestedVersion(pkg) {
  const { year, month } = calverThisMonth();
  const parsed = parseVersion(pkg.version);
  if (parsed && parsed.year === year && parsed.month === month) {
    if (npmHasVersion(pkg.name, pkg.version)) {
      return `${year}.${month}.${parsed.iteration + 1}`;
    }
    return pkg.version;
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
  if (git(["rev-parse", "--is-inside-work-tree"]).status !== 0) {
    console.error("Initialize a git repository and add a remote before releasing.");
    process.exit(1);
  }
  if (git(["status", "--porcelain"]).stdout.trim()) {
    console.error("Working tree is not clean. Commit or stash changes before releasing.");
    process.exit(1);
  }
  if (!git(["remote"]).stdout.trim()) {
    console.error("No git remote configured. Add one before releasing.");
    process.exit(1);
  }
}

function readPkg() {
  return JSON.parse(readFileSync(pkgPath, "utf8"));
}

function writePkgVersion(version) {
  const pkg = readPkg();
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function githubReleaseExists(tag) {
  return spawnSync("gh", ["release", "view", tag], { cwd: root, stdio: "ignore" }).status === 0;
}

assertGitReady();

const pkg = readPkg();
const current = pkg.version;
const version = await askVersion(suggestedVersion(pkg));
if (!parseVersion(version)) {
  console.error(`Invalid version "${version}". Use {year}.{month}.{iteration} such as 2026.9.1.`);
  process.exit(1);
}

const releaseTag = `v${version}`;

run("npm", ["run", "check"]);
run("npm", ["run", "build"]);

if (current !== version) {
  writePkgVersion(version);
  run("npm", ["install", "--package-lock-only"]);
  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `chore: release ${releaseTag}`]);
} else {
  console.log(`package.json already at ${version}, skipping version commit.`);
}

if (!tagExists(version)) {
  run("git", ["tag", releaseTag]);
} else {
  console.log(`Git tag for ${version} already exists, skipping tag.`);
}

run("git", ["push", "--follow-tags"]);

if (githubReleaseExists(releaseTag)) {
  console.log(`GitHub release ${releaseTag} already exists, skipping.`);
} else {
  run("npm", ["run", "release:github"]);
}

run("npm", ["publish"]);
