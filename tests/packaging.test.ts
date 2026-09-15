import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
const XANGI_V0564_COMMIT = "726ecfc7f1e6d9bf7d553c203cff0a7b0a43b84e";

function directory(name: string): string {
  const value = mkdtempSync(join(tmpdir(), `${name}-`));
  temporary.push(value);
  return value;
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("managed bundle installation", () => {
  it("packages every launcher dependency", () => {
    const script = readFileSync(
      join(process.cwd(), "packaging", "build-bundle.sh"),
      "utf8",
    );
    expect(script).toContain('cp -R "$project_root/bin/." "$root/bin/"');
    expect(script).toContain('cp "$project_root/install.sh" "$root/"');
    expect(script).toContain('cp -R "$project_root/licenses" "$root/"');
    expect(
      existsSync(
        join(process.cwd(), "licenses", "OpenShell-THIRD-PARTY-NOTICES"),
      ),
    ).toBe(true);
    expect(
      readFileSync(join(process.cwd(), "bin", "neonxangi.js"), "utf8"),
    ).toContain('from "./build-state.js"');
  });

  it("installs from one bootstrap command and uses the bundled runtimes", () => {
    const release = directory("neonxangi-release");
    const fixture = directory("neonxangi-fixture");
    const appRoot = join(fixture, "app");
    const commandDir = join(fixture, "bin");
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const name = `neonxangi-0.1.0-${platform}-${arch}`;
    const root = join(fixture, name);
    mkdirSync(join(root, "runtime", "bin"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    executable(
      join(root, "runtime", "bin", "node"),
      'printf "%s\\n" "$NEONXANGI_OPENSHELL"',
    );
    executable(
      join(root, "runtime", "bin", "openshell"),
      'printf "openshell 0.0.116\\n"',
    );
    copyFileSync(
      join(process.cwd(), "bin", "neonxangi"),
      join(root, "bin", "neonxangi"),
    );
    chmodSync(join(root, "bin", "neonxangi"), 0o755);
    writeFileSync(join(root, "bin", "neonxangi.js"), "");

    const asset = `neonxangi-${platform}-${arch}.tar.gz`;
    execFileSync("tar", ["-czf", join(release, asset), "-C", fixture, name]);
    copyFileSync(
      join(process.cwd(), "packaging", "install-bundle.sh"),
      join(release, "install-bundle.sh"),
    );
    const checksum = execFileSync(
      "sha256sum",
      [join(release, asset), join(release, "install-bundle.sh")],
      { encoding: "utf8" },
    )
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(
        (line) =>
          `${line.split(/\s/u)[0]}  ${line.includes(asset) ? asset : "install-bundle.sh"}`,
      )
      .join("\n");
    writeFileSync(
      join(release, "neonxangi-checksums-sha256.txt"),
      `${checksum}\n`,
    );

    const environment = {
      ...process.env,
      NEONXANGI_RELEASE_BASE_URL: `file://${release}`,
      NEONXANGI_APP_ROOT: appRoot,
      NEONXANGI_COMMAND_DIR: commandDir,
    };
    execFileSync("sh", [join(process.cwd(), "install.sh")], {
      env: environment,
    });
    const repeated = execFileSync("sh", [join(process.cwd(), "install.sh")], {
      encoding: "utf8",
      env: { ...environment, NEONXANGI_INSTALL_MODE: "update" },
    });
    expect(repeated).toContain("Already up to date:");

    const command = join(commandDir, "neonxangi");
    expect(existsSync(command)).toBe(true);
    expect(readlinkSync(command)).toBe(join(appRoot, "bin", "neonxangi"));
    expect(
      execFileSync(command, ["setup"], {
        encoding: "utf8",
        env: { ...process.env, NEONXANGI_APP_ROOT: appRoot },
      }).trim(),
    ).toBe(join(appRoot, "current", "runtime", "bin", "openshell"));
  });

  it("refuses a release without an asset checksum", () => {
    const release = directory("neonxangi-release");
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    writeFileSync(join(release, "neonxangi-checksums-sha256.txt"), "");
    writeFileSync(join(release, `neonxangi-${platform}-${arch}.tar.gz`), "bad");
    copyFileSync(
      join(process.cwd(), "packaging", "install-bundle.sh"),
      join(release, "install-bundle.sh"),
    );
    expect(() =>
      execFileSync("sh", [join(process.cwd(), "install.sh")], {
        stdio: "pipe",
        env: {
          ...process.env,
          NEONXANGI_RELEASE_BASE_URL: `file://${release}`,
        },
      }),
    ).toThrow();
  });
});

describe("blueprint xangi compatibility", () => {
  it("pins released xangi without downstream source patches", () => {
    const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
    const manifest = readFileSync(
      join(process.cwd(), "blueprint", "manifest.yaml"),
      "utf8",
    );

    expect(dockerfile).toContain(`ARG XANGI_COMMIT=${XANGI_V0564_COMMIT}`);
    expect(dockerfile).not.toContain("git -C /opt/xangi apply");
    expect(manifest).toContain("xangi_release: v0.56.4");
    expect(manifest).toContain(`xangi_commit: ${XANGI_V0564_COMMIT}`);
    expect(manifest).not.toContain("xangi_integration_patch");
    expect(manifest).not.toContain("xangi_remote_platform_patch");
    expect(
      existsSync(join(process.cwd(), "blueprint", "xangi-openshell-env.patch")),
    ).toBe(false);
    expect(
      existsSync(
        join(process.cwd(), "blueprint", "xangi-remote-platform.patch"),
      ),
    ).toBe(false);
  });
});
