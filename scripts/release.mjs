import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const requestedVersion = process.argv[2];
if (requestedVersion === "--help" || requestedVersion === "-h") {
  console.log("Usage: npm run release -- <version>");
  process.exit(0);
}
if (requestedVersion === undefined) {
  throw new Error("Pass the release version, for example: npm run release -- 0.2.0");
}

const version = requestedVersion.replace(/^v/u, "");
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version)) {
  throw new Error(`Invalid semantic version: ${requestedVersion}`);
}

const tag = `v${version}`;
const versionFiles = ["package.json", "package-lock.json", "openclaw.plugin.json"];
const originals = new Map(
  await Promise.all(versionFiles.map(async (path) => [path, await readFile(path, "utf8")])),
);
const packageJson = JSON.parse(originals.get("package.json"));
const manifest = JSON.parse(originals.get("openclaw.plugin.json"));

if (packageJson.version !== manifest.version) {
  throw new Error("package.json and openclaw.plugin.json versions already differ");
}
if (packageJson.version === version) {
  throw new Error(`${tag} is already the current source version`);
}

requireSuccess("git", ["diff", "--quiet"]);
requireSuccess("git", ["diff", "--cached", "--quiet"]);
if (capture("git", ["ls-files", "--others", "--exclude-standard"]) !== "") {
  throw new Error("The worktree has untracked files");
}
if (capture("git", ["branch", "--show-current"]) !== "main") {
  throw new Error("Releases must run from main");
}

requireSuccess("gh", ["auth", "status"]);
requireSuccess("git", ["fetch", "origin", "main", "--tags"]);
if (capture("git", ["rev-parse", "HEAD"]) !== capture("git", ["rev-parse", "origin/main"])) {
  throw new Error("Local main must exactly match origin/main");
}
if (spawn("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]).status === 0) {
  throw new Error(`Tag already exists: ${tag}`);
}

const publishedVersion = spawn("npm", ["view", `${packageJson.name}@${version}`, "version"]);
if (publishedVersion.status === 0) {
  throw new Error(`${packageJson.name}@${version} is already published`);
}
if (!publishedVersion.stderr.includes("E404")) {
  throw new Error(`Could not verify npm version availability:\n${publishedVersion.stderr.trim()}`);
}

try {
  requireSuccess("npm", ["version", version, "--no-git-tag-version"]);
  const manifestSource = originals.get("openclaw.plugin.json");
  const currentVersionLine = `  "version": "${manifest.version}",`;
  if (manifestSource.split(currentVersionLine).length !== 2) {
    throw new Error("Could not locate the manifest version line exactly once");
  }
  await writeFile(
    "openclaw.plugin.json",
    manifestSource.replace(currentVersionLine, `  "version": "${version}",`),
  );
  requireSuccess("npm", ["run", "release:check", "--", tag]);
  requireSuccess("npm", ["run", "preflight"]);
} catch (error) {
  await Promise.all([...originals].map(([path, contents]) => writeFile(path, contents)));
  throw error;
}

requireSuccess("git", ["add", ...versionFiles]);
requireSuccess("git", ["commit", "-m", `chore: release ${tag}`]);
requireSuccess("git", ["tag", "-a", tag, "-m", tag]);
requireSuccess("git", ["push", "--atomic", "origin", "main", `refs/tags/${tag}`]);

const releaseArguments = ["release", "create", tag, "--verify-tag", "--generate-notes", "--title", tag];
if (version.includes("-")) releaseArguments.push("--prerelease");
requireSuccess("gh", releaseArguments);

console.log(`${tag} released. GitHub Actions will publish ${packageJson.name}@${version} to npm.`);

function capture(command, args) {
  const result = spawn(command, args);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function requireSuccess(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function spawn(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}
