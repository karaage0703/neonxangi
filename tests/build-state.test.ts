import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSourceBuildCurrent,
  writeSourceBuildState,
} from "../bin/build-state.js";

const temporary: string[] = [];

function sourceCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "neonxangi-build-state-"));
  temporary.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "src", "cli.ts"), "export const value = 1;\n");
  for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json"])
    writeFileSync(join(root, file), "{}\n");
  return root;
}

afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("source build state", () => {
  it("accepts an unchanged source checkout", async () => {
    const root = sourceCheckout();
    await writeSourceBuildState(root);
    await expect(assertSourceBuildCurrent(root)).resolves.toBeUndefined();
  });

  it("rejects source changes after the build", async () => {
    const root = sourceCheckout();
    await writeSourceBuildState(root);
    writeFileSync(join(root, "src", "cli.ts"), "export const value = 2;\n");
    await expect(assertSourceBuildCurrent(root)).rejects.toThrow(
      "Run `npm run build`",
    );
  });

  it("skips the source check for managed bundles", async () => {
    const root = mkdtempSync(join(tmpdir(), "neonxangi-build-state-"));
    temporary.push(root);
    await expect(assertSourceBuildCurrent(root)).resolves.toBeUndefined();
  });
});
