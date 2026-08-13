import { readFile } from "node:fs/promises";

const releaseTag = process.argv[2] ?? process.env.RELEASE_TAG;
if (releaseTag === undefined) {
  throw new Error("Pass the GitHub release tag as the first argument or RELEASE_TAG");
}

const [packageJson, manifest] = await Promise.all([
  readJson("package.json"),
  readJson("openclaw.plugin.json"),
]);
const releaseVersion = releaseTag.replace(/^v/u, "");

if (packageJson.version !== releaseVersion) {
  throw new Error(`package.json is ${String(packageJson.version)}, release is ${releaseVersion}`);
}
if (manifest.version !== releaseVersion) {
  throw new Error(`openclaw.plugin.json is ${String(manifest.version)}, release is ${releaseVersion}`);
}

console.log(`Release versions match: ${releaseVersion}`);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}
