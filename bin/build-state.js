import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_STATE_FILE = "dist/.source-build-sha256";
const ROOT_INPUTS = ["package.json", "tsconfig.json", "tsconfig.build.json"];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return files.flat();
}

async function sourceExists(root) {
  try {
    return (await stat(resolve(root, "src"))).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function sourceBuildHash(root) {
  const rootPath = root instanceof URL ? fileURLToPath(root) : root;
  const sourceFiles = await filesBelow(resolve(rootPath, "src"));
  const files = [
    ...ROOT_INPUTS.map((path) => resolve(rootPath, path)),
    ...sourceFiles,
  ].sort();
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(rootPath, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function writeSourceBuildState(root) {
  const rootPath = root instanceof URL ? fileURLToPath(root) : root;
  const hash = await sourceBuildHash(root);
  await writeFile(resolve(rootPath, BUILD_STATE_FILE), `${hash}\n`);
}

export async function assertSourceBuildCurrent(root) {
  const rootPath = root instanceof URL ? fileURLToPath(root) : root;
  if (!(await sourceExists(rootPath))) return;

  let builtHash;
  try {
    builtHash = (
      await readFile(resolve(rootPath, BUILD_STATE_FILE), "utf8")
    ).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const currentHash = await sourceBuildHash(rootPath);
  if (builtHash !== currentHash) {
    throw new Error(
      "Neon Xangi source files are newer than the compiled runtime. Run `npm run build` and retry.",
    );
  }
}
