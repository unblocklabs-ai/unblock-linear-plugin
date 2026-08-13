import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(packageRoot, "dist");

if (dirname(outputDirectory) !== packageRoot || outputDirectory === packageRoot) {
  throw new Error(`Refusing to clean an unsafe build output path: ${outputDirectory}`);
}

await rm(outputDirectory, { recursive: true, force: true });
