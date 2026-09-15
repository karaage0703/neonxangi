import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateInstallation, type InstallerRunner } from "../src/update.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "neonxangi-update-"));
  temporary.push(path);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "install.sh"), "#!/bin/sh\n");
  return path;
}

describe("managed update", () => {
  it("runs the bundled installer in update mode", () => {
    let invocation: [string, string[], NodeJS.ProcessEnv] | undefined;
    const runner: InstallerRunner = (command, args, environment) => {
      invocation = [command, args, environment];
      return { status: 0 };
    };
    const projectRoot = root();

    updateInstallation(projectRoot, runner);

    expect(invocation?.[0]).toBe("sh");
    expect(invocation?.[1]).toEqual([join(projectRoot, "install.sh")]);
    expect(invocation?.[2].NEONXANGI_INSTALL_MODE).toBe("update");
  });

  it("reports installer failure", () => {
    expect(() => updateInstallation(root(), () => ({ status: 1 }))).toThrow(
      "update installer exited with status 1",
    );
  });
});
