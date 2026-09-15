import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { delimiter } from "node:path";
import { dumpPolicy } from "./policy.js";

export class OpenShellError extends Error {}

export interface CommandResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

export function findExecutable(name: string): string | undefined {
  if (name.includes("/")) {
    const result = spawnSync(name, ["--version"], { stdio: "ignore" });
    return result.error ? undefined : name;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = `${directory}/${name}`;
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error) return candidate;
  }
  return undefined;
}

function versionTuple(value: string): [number, number, number] {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (!match)
    throw new OpenShellError(
      `unable to parse OpenShell version: ${JSON.stringify(value)}`,
    );
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export class OpenShell {
  readonly executable: string;

  constructor(executable = process.env.NEONXANGI_OPENSHELL ?? "openshell") {
    const resolved = findExecutable(executable);
    if (!resolved)
      throw new OpenShellError(`OpenShell executable not found: ${executable}`);
    this.executable = resolved;
  }

  run(
    args: string[],
    options: {
      check?: boolean;
      timeout?: number;
      stdio?: "inherit" | "pipe";
      environment?: NodeJS.ProcessEnv;
    } = {},
  ): CommandResult {
    const result = spawnSync(this.executable, args, {
      encoding: "utf8",
      timeout: options.timeout ?? 120_000,
      stdio: options.stdio ?? "pipe",
      env: options.environment,
    });
    if (result.error) throw new OpenShellError(String(result.error));
    const commandResult: CommandResult = {
      returncode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
    if ((options.check ?? true) && commandResult.returncode !== 0) {
      throw new OpenShellError(
        commandResult.stderr.trim() || commandResult.stdout.trim(),
      );
    }
    return commandResult;
  }

  version(): string {
    return this.run(["--version"]).stdout.trim();
  }

  requireVersion(minimum: string): void {
    const current = versionTuple(this.version());
    if (compareVersion(current, versionTuple(minimum)) < 0) {
      throw new OpenShellError(
        `OpenShell ${minimum}+ is required; installed version is ${current.join(".")}`,
      );
    }
  }

  requireVersionRange(minimum: string, maximumExclusive: string): void {
    const current = versionTuple(this.version());
    if (
      compareVersion(current, versionTuple(minimum)) < 0 ||
      compareVersion(current, versionTuple(maximumExclusive)) >= 0
    ) {
      throw new OpenShellError(
        `OpenShell >=${minimum},<${maximumExclusive} is required; installed version is ${current.join(".")}`,
      );
    }
  }

  listSandboxes(): Array<Record<string, unknown>> {
    const value = JSON.parse(
      this.run(["sandbox", "list", "-o", "json"]).stdout,
    ) as unknown;
    if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
    if (
      value &&
      typeof value === "object" &&
      Array.isArray((value as Record<string, unknown>).sandboxes)
    ) {
      return (value as { sandboxes: Array<Record<string, unknown>> }).sandboxes;
    }
    throw new OpenShellError("OpenShell returned invalid sandbox JSON");
  }

  providerNames(): Set<string> {
    return new Set(
      this.run(["provider", "list", "--names"])
        .stdout.split(/\r?\n/u)
        .map((name) => name.trim())
        .filter(Boolean),
    );
  }

  ensureProvider(input: {
    name: string;
    type: string;
    credentialNames: string[];
    environment: NodeJS.ProcessEnv;
  }): void {
    const exists = this.providerNames().has(input.name);
    const args = exists
      ? ["provider", "update", input.name]
      : ["provider", "create", "--name", input.name, "--type", input.type];
    for (const name of input.credentialNames) args.push("--credential", name);
    this.run(args, { environment: input.environment });
  }

  create(input: {
    name: string;
    source: string;
    policy: string;
    providers?: string[];
    uploads?: Array<[string, string]>;
    autoProviders?: boolean;
    environment?: NodeJS.ProcessEnv;
  }): void {
    const args = [
      "sandbox",
      "create",
      "--name",
      input.name,
      "--from",
      input.source,
      "--policy",
      input.policy,
    ];
    if (input.autoProviders) args.push("--auto-providers");
    for (const provider of input.providers ?? [])
      args.push("--provider", provider);
    for (const [local, remote] of input.uploads ?? [])
      args.push("--upload", `${local}:${remote}`);
    args.push("--detach", "--no-tty");
    this.run(args, {
      timeout: 900_000,
      ...(input.environment ? { environment: input.environment } : {}),
    });
  }

  startServiceForward(input: {
    name: string;
    targetPort: number;
    localHost: string;
    localPort: number;
    logPath: string;
  }): ChildProcess {
    const fd = openSync(input.logPath, "a", 0o600);
    const child = spawn(
      this.executable,
      [
        "forward",
        "service",
        "--target-port",
        String(input.targetPort),
        "--local",
        `${input.localHost}:${input.localPort}`,
        input.name,
      ],
      { stdio: ["ignore", fd, fd] },
    );
    closeSync(fd);
    return child;
  }

  exec(name: string, command: string[], timeout = 120_000): CommandResult {
    return this.run(
      ["sandbox", "exec", "--name", name, "--no-tty", "--", ...command],
      { timeout },
    );
  }

  delete(name: string): void {
    this.run(["sandbox", "delete", name]);
  }

  download(name: string, remote: string, local: string): void {
    this.run(["sandbox", "download", name, remote, local], {
      timeout: 300_000,
    });
  }

  upload(name: string, local: string, remote: string): void {
    this.run(["sandbox", "upload", "--no-git-ignore", name, local, remote], {
      timeout: 300_000,
    });
  }

  policyGet(name: string, timeout = 120_000): string {
    const raw = JSON.parse(
      this.run(["policy", "get", name, "--base", "-o", "json"], {
        timeout,
      }).stdout,
    ) as Record<string, unknown>;
    if (!raw.policy || typeof raw.policy !== "object") {
      throw new OpenShellError("OpenShell returned invalid policy JSON");
    }
    return dumpPolicy(raw.policy);
  }

  policySet(name: string, policy: string): void {
    this.run(["policy", "set", name, "--policy", policy, "--wait"]);
  }

  connect(name: string): number {
    return this.run(["sandbox", "connect", name], {
      check: false,
      stdio: "inherit",
    }).returncode;
  }
}
