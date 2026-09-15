import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export class SnapshotError extends Error {}

export const EXCLUDED_NAMES = new Set([
  "capability-private.pem",
  "console-token",
  "discord-token",
  "bridge.pid",
  "broker.pid",
  "host.pid",
]);
const EXCLUDED_SUFFIXES = new Set([".sock", ".lock", ".pid"]);

function included(path: string): boolean {
  return (
    !EXCLUDED_NAMES.has(basename(path)) && !EXCLUDED_SUFFIXES.has(extname(path))
  );
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function files(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface SnapshotManifest {
  schema_version: number;
  created_at: string;
  files: ManifestEntry[];
  excluded: string[];
}

export function createSnapshot(
  sourceValue: string,
  destinationRootValue: string,
  extraFiles: Array<[string, string]> = [],
): string {
  const source = resolve(sourceValue);
  const destinationRoot = resolve(destinationRootValue);
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  const destination = join(destinationRoot, `snapshot-${stamp}`);
  if (existsSync(destination))
    throw new SnapshotError("snapshot destination already exists");
  const dataDir = join(destination, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const entries: ManifestEntry[] = [];
  for (const item of files(source)) {
    if (!included(item)) continue;
    const relativePath = relative(source, item);
    if (relativePath.split(sep).some((part) => !included(part))) continue;
    if (relativePath.split(sep)[0] === basename(destinationRoot)) continue;
    const target = join(dataDir, relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(item, target);
    entries.push({
      path: relativePath,
      sha256: digest(target),
      size: statSync(target).size,
    });
  }
  for (const [item, relativePath] of extraFiles) {
    if (
      isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/u).includes("..") ||
      !statSync(item).isFile()
    ) {
      throw new SnapshotError("invalid extra snapshot file");
    }
    const target = join(dataDir, relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(item, target);
    entries.push({
      path: relativePath,
      sha256: digest(target),
      size: statSync(target).size,
    });
  }
  const manifest: SnapshotManifest = {
    schema_version: 1,
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    files: entries,
    excluded: [...EXCLUDED_NAMES].sort(),
  };
  writeFileSync(
    join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return destination;
}

export function verifySnapshot(snapshot: string): SnapshotManifest {
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(snapshot, "manifest.json"), "utf8"),
    ) as SnapshotManifest;
  } catch (error) {
    throw new SnapshotError(`invalid snapshot manifest: ${String(error)}`);
  }
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.files)) {
    throw new SnapshotError("unsupported snapshot manifest");
  }
  for (const entry of manifest.files) {
    const path = join(snapshot, "data", entry.path);
    if (!existsSync(path) || digest(path) !== entry.sha256) {
      throw new SnapshotError(`snapshot integrity check failed: ${entry.path}`);
    }
  }
  return manifest;
}

export function restoreSnapshot(snapshot: string, destination: string): void {
  const manifest = verifySnapshot(snapshot);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  if (readdirSync(destination).length > 0)
    throw new SnapshotError("restore destination must be empty");
  for (const entry of manifest.files) {
    const source = join(snapshot, "data", entry.path);
    const target = join(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
  }
}
