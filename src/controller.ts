import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { ApprovalStore } from "./approvals.js";
import { AuditLog } from "./audit.js";
import { BridgeDispatcher } from "./bridge.js";
import { Broker, serveBroker } from "./broker.js";
import {
  generateKeypair,
  loadPrivateKey,
  loadPublicKey,
} from "./capability.js";
import {
  ConfigError,
  defaultStateDir,
  expandHome,
  loadConfig,
  readSecret,
  type AppConfig,
} from "./config.js";
import { Console, serveConsole } from "./console.js";
import { DiscordBridge } from "./discord-bridge.js";
import { OpenShell } from "./openshell.js";
import {
  loadPolicy,
  parsePolicyText,
  policyMatchesConfiguration,
  policyForBackend,
  profilePath,
  summarizePolicy,
} from "./policy.js";
import {
  publicConfig,
  savePublic,
  validatePublic,
  type Check,
} from "./settings.js";
import { SlackBridge } from "./slack-bridge.js";

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/gu;

export function projectRoot(): string {
  if (process.env.NEONXANGI_ROOT)
    return resolve(expandHome(process.env.NEONXANGI_ROOT));
  const checkout = process.cwd();
  if (
    existsSync(join(checkout, "Dockerfile")) &&
    existsSync(join(checkout, "blueprint"))
  ) {
    return resolve(checkout);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function ensureHostIdentity(stateDir: string): [string, string, string] {
  const keys = join(stateDir, "keys");
  const privatePath = join(keys, "capability-private.pem");
  const publicPath = join(keys, "capability-public.pem");
  if (!existsSync(privatePath) && !existsSync(publicPath))
    generateKeypair(keys);
  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    throw new ConfigError("capability keypair is incomplete");
  }
  const tokenPath = join(keys, "console-token");
  if (!existsSync(tokenPath)) {
    mkdirSync(keys, { recursive: true, mode: 0o700 });
    const fd = openSync(tokenPath, "wx", 0o600);
    try {
      writeFileSync(fd, `${randomBytes(32).toString("base64url")}\n`);
    } finally {
      closeSync(fd);
    }
  }
  chmodSync(tokenPath, 0o600);
  return [privatePath, publicPath, tokenPath];
}

export function doctor(
  config: AppConfig,
  root = projectRoot(),
  stateDir = defaultStateDir(),
): Check[] {
  const checks: Check[] = [];
  const add = (name: string, status: "pass" | "fail", detail: string): void => {
    checks.push({ name, status, detail: detail.replaceAll(ANSI_ESCAPE, "") });
  };
  add(
    "host",
    process.platform === "linux" ? "pass" : "fail",
    process.platform === "linux"
      ? "Linux host"
      : "OpenShell host currently requires Linux",
  );
  try {
    const shell = new OpenShell();
    try {
      shell.requireVersion(config.runtime.openshell_min_version);
      add("openshell", "pass", shell.version());
    } catch (error) {
      add(
        "openshell",
        "fail",
        error instanceof Error ? error.message : String(error),
      );
    }
    const gateway = shell.run(["gateway", "info"], { check: false });
    add(
      "gateway",
      gateway.returncode === 0 ? "pass" : "fail",
      (gateway.stdout || gateway.stderr).trim(),
    );
  } catch {
    add("openshell", "fail", "openshell executable not found");
  }
  const workspace = config.runtime.workspace
    ? resolve(expandHome(config.runtime.workspace))
    : "";
  if (workspace && existsSync(workspace)) add("workspace", "pass", workspace);
  else
    add(
      "workspace",
      "fail",
      "runtime.workspace must reference an existing directory",
    );
  try {
    const path = profilePath(root, config.runtime.profile);
    loadPolicy(path);
    add("policy", "pass", path);
  } catch (error) {
    add(
      "policy",
      "fail",
      error instanceof Error ? error.message : String(error),
    );
  }
  const keys = join(stateDir, "keys");
  const expected = [
    "capability-private.pem",
    "capability-public.pem",
    "console-token",
  ];
  const missing = expected.filter((name) => !existsSync(join(keys, name)));
  if (missing.length > 0)
    add(
      "identity",
      "fail",
      `missing host identity: ${missing.join(", ")}; run onboard`,
    );
  else add("identity", "pass", expected.join(", "));
  return checks;
}

export async function portOpen(
  host: string,
  port: number,
  timeout = 200,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const done = (value: boolean): void => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeout, () => done(false));
  });
}

export async function status(
  config: AppConfig,
  shell?: OpenShell,
): Promise<Record<string, unknown>> {
  let sandboxes: Array<Record<string, unknown>> = [];
  let openshellError = "";
  try {
    sandboxes = (shell ?? new OpenShell()).listSandboxes();
  } catch (error) {
    openshellError = error instanceof Error ? error.message : String(error);
  }
  return {
    sandbox: config.runtime.sandbox_name,
    profile: config.runtime.profile,
    workspace: config.runtime.workspace,
    openshell_error: openshellError,
    sandboxes,
    broker: {
      healthy: await portOpen(
        config.runtime.broker_bind,
        config.runtime.broker_port,
      ),
    },
    console: {
      healthy: await portOpen(
        config.runtime.console_bind,
        config.runtime.console_port,
      ),
    },
    credentials: {
      discord: Boolean(config.discord.token_file),
      slack: Boolean(config.slack.token_file),
    },
  };
}

function buildConsole(input: {
  configFile: string;
  stateDir: string;
  runtimeStatus: () =>
    Promise<Record<string, unknown>> | Record<string, unknown>;
  audit?: AuditLog;
  approvals?: ApprovalStore;
}): { console: Console; approvals: ApprovalStore } {
  const [, , tokenPath] = ensureHostIdentity(input.stateDir);
  const audit =
    input.audit ?? new AuditLog(join(input.stateDir, "audit.jsonl"));
  const approvals =
    input.approvals ??
    new ApprovalStore(join(input.stateDir, "approvals.json"));
  const current = (): AppConfig => loadConfig(input.configFile);
  return {
    approvals,
    console: new Console({
      token: readFileSync(tokenPath, "utf8").trim(),
      audit,
      approvals,
      status: input.runtimeStatus,
      policy: () => {
        const config = current();
        const path = profilePath(projectRoot(), config.runtime.profile);
        const configured = policyForBackend(
          loadPolicy(path),
          config.runtime.backend,
          config.runtime.local_llm_base_url,
        );
        let effective = configured;
        let source: "active" | "configured" = "configured";
        let activeError = "";
        let matchesConfig: boolean | null = null;
        try {
          const activeText = new OpenShell().policyGet(
            config.runtime.sandbox_name,
            3_000,
          );
          effective = parsePolicyText(activeText, "active OpenShell policy");
          source = "active";
          matchesConfig = policyMatchesConfiguration(effective, configured);
        } catch (error) {
          activeError = error instanceof Error ? error.message : String(error);
        }
        return {
          profile: config.runtime.profile,
          backend: config.runtime.backend,
          sandbox: config.runtime.sandbox_name,
          path,
          source,
          matches_config: matchesConfig,
          active_error: activeError,
          summary: summarizePolicy(effective, config.runtime.backend),
          platforms: {
            discord: {
              enabled: config.discord.enabled,
              allowed_users: config.discord.allowed_users.length,
              allowed_channels: config.discord.allowed_channels.length,
              auto_reply_channels: config.discord.auto_reply_channels.length,
            },
            slack: {
              enabled: config.slack.enabled,
              allowed_users: config.slack.allowed_users.length,
              allowed_channels: config.slack.allowed_channels.length,
              auto_reply_channels: config.slack.auto_reply_channels.length,
            },
          },
        };
      },
      config: () => publicConfig(current()),
      validateConfig: (value) => validatePublic(value, current()),
      saveConfig: (value) => savePublic(value, input.configFile, current()),
      doctor: () => doctor(current(), projectRoot(), input.stateDir),
      webRoot: join(projectRoot(), "web"),
    }),
  };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.unref();
}

function waitForSignal(): Promise<void> {
  return new Promise((resolvePromise) => {
    const stop = (): void => resolvePromise();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

export async function serveSettings(
  configFile: string,
  stateDir: string,
  open = true,
): Promise<void> {
  const config = loadConfig(configFile);
  const url = `http://${config.runtime.console_bind}:${config.runtime.console_port}`;
  const [, , tokenPath] = ensureHostIdentity(stateDir);
  const token = readFileSync(tokenPath, "utf8").trim();
  let alreadyRunning = false;
  try {
    const response = await fetch(`${url}/api/config`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(300),
    });
    alreadyRunning = response.ok;
  } catch {
    alreadyRunning = false;
  }
  if (alreadyRunning) {
    if (open) {
      const response = await fetch(`${url}/api/session/bootstrap`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Consoleのbrowser認証を開始できません");
      const value = (await response.json()) as { path?: string };
      if (!value.path) throw new Error("Consoleのbrowser認証URLがありません");
      openBrowser(new URL(value.path, url).toString());
    }
    console.log(`Neon Xangi Console: ${url}`);
    console.log("Browser authentication: automatic");
    return;
  }
  const built = buildConsole({
    configFile,
    stateDir,
    runtimeStatus: () => ({
      sandbox: loadConfig(configFile).runtime.sandbox_name,
      profile: loadConfig(configFile).runtime.profile,
      workspace: loadConfig(configFile).runtime.workspace,
      broker: { healthy: false },
      console: { healthy: true },
      settings_mode: true,
    }),
  });
  const server = serveConsole(
    built.console,
    config.runtime.console_bind,
    config.runtime.console_port,
  );
  console.log(`Neon Xangi Console: ${url}`);
  if (open) {
    openBrowser(new URL(built.console.createBrowserSession(), url).toString());
    console.log("Browser authentication: automatic");
  } else {
    console.log(`Manual recovery token: ${tokenPath}`);
  }
  await waitForSignal();
  await closeServer(server);
  built.approvals.close();
}

async function waitForPort(
  host: string,
  port: number,
  child: ReturnType<OpenShell["startServiceForward"]>,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error("OpenShell integration forward exited during startup");
    if (await portOpen(host, port)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("OpenShell integration forward did not become ready");
}

export async function serveHost(
  config: AppConfig,
  stateDir = defaultStateDir(),
  configFile = join(stateDir, "config.json"),
): Promise<void> {
  const [privatePath, publicPath] = ensureHostIdentity(stateDir);
  const audit = new AuditLog(join(stateDir, "audit.jsonl"));
  const approvals = new ApprovalStore(join(stateDir, "approvals.json"));
  const workspace = resolve(expandHome(config.runtime.workspace));
  const broker = new Broker({
    workspaceId: basename(workspace),
    workspace,
    sandboxId: config.runtime.sandbox_name,
    publicKey: loadPublicKey(publicPath),
    audit,
    approvals,
  });
  const integration = new URL(config.runtime.integration_url);
  if (
    integration.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(integration.hostname)
  ) {
    throw new ConfigError(
      "runtime.integration_url must be a loopback HTTP URL",
    );
  }
  const integrationPort = Number(integration.port || 80);
  const forwardLogPath = join(stateDir, "integration-forward.log");
  const shell = new OpenShell();
  const forward = shell.startServiceForward({
    name: config.runtime.sandbox_name,
    targetPort: integrationPort,
    localHost: integration.hostname,
    localPort: integrationPort,
    logPath: forwardLogPath,
  });
  try {
    await waitForPort(integration.hostname, integrationPort, forward);
  } catch (error) {
    forward.kill("SIGTERM");
    throw new Error(`${String(error)}; inspect ${forwardLogPath}`);
  }
  const brokerServer = serveBroker(
    broker,
    config.runtime.broker_bind,
    config.runtime.broker_port,
  );
  const built = buildConsole({
    configFile,
    stateDir,
    runtimeStatus: () => status(config),
    audit,
    approvals,
  });
  const consoleServer = serveConsole(
    built.console,
    config.runtime.console_bind,
    config.runtime.console_port,
  );
  const dispatcher = new BridgeDispatcher({
    integrationUrl: config.runtime.integration_url,
    privateKey: loadPrivateKey(privatePath),
    sandboxId: config.runtime.sandbox_name,
    workspaceId: basename(workspace),
    audit,
  });
  let discord: DiscordBridge | undefined;
  let slack: SlackBridge | undefined;
  try {
    if (config.discord.enabled) {
      discord = new DiscordBridge({
        dispatcher,
        allowedUsers: new Set(config.discord.allowed_users),
        allowedBots: new Set(config.discord.allowed_bots),
        allowedChannels: new Set(config.discord.allowed_channels),
        autoReplyChannels: new Set(config.discord.auto_reply_channels),
        botMaxConsecutive: config.discord.bot_max_consecutive,
        quarantineDir: join(stateDir, "quarantine", "discord"),
      });
      await discord.start(
        readSecret(config.discord.token_file, config.discord.token_key),
      );
    }
    if (config.slack.enabled) {
      slack = new SlackBridge({
        dispatcher,
        botToken: readSecret(
          config.slack.token_file,
          config.slack.bot_token_key,
        ),
        appToken: readSecret(
          config.slack.token_file,
          config.slack.app_token_key,
        ),
        allowedUsers: new Set(config.slack.allowed_users),
        allowedChannels: new Set(config.slack.allowed_channels),
        autoReplyChannels: new Set(config.slack.auto_reply_channels),
        quarantineDir: join(stateDir, "quarantine", "slack"),
      });
      await slack.start();
    }
    audit.write({
      component: "controller",
      action: "host.start",
      outcome: "completed",
    });
    await waitForSignal();
  } finally {
    await Promise.allSettled([
      closeServer(brokerServer),
      closeServer(consoleServer),
      discord?.stop() ?? Promise.resolve(),
      slack?.stop() ?? Promise.resolve(),
    ]);
    forward.kill("SIGTERM");
    approvals.close();
    audit.write({
      component: "controller",
      action: "host.stop",
      outcome: "completed",
    });
  }
}

export async function startDaemon(
  configFile: string,
  stateDir: string,
): Promise<number> {
  const pidPath = join(stateDir, "host.pid");
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    try {
      process.kill(pid, 0);
      throw new Error(`Neon Xangi host is already running as PID ${pid}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Neon Xangi host"))
        throw error;
      unlinkSync(pidPath);
    }
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const logPath = join(stateDir, "host.log");
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(
    process.execPath,
    [
      join(projectRoot(), "bin", "neonxangi.js"),
      "serve",
      "--config",
      configFile,
    ],
    {
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  child.unref();
  closeSync(log);
  if (!child.pid)
    throw new Error(
      `Neon Xangi host exited during startup; inspect ${logPath}`,
    );
  writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600, flag: "wx" });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  try {
    process.kill(child.pid, 0);
  } catch {
    rmSync(pidPath, { force: true });
    throw new Error(
      `Neon Xangi host exited during startup; inspect ${logPath}`,
    );
  }
  return child.pid;
}

export async function stopDaemon(stateDir: string): Promise<number> {
  const pidPath = join(stateDir, "host.pid");
  if (!existsSync(pidPath)) throw new Error("Neon Xangi host is not running");
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    } catch {
      rmSync(pidPath, { force: true });
      return pid;
    }
  }
  throw new Error(`Neon Xangi host PID ${pid} did not stop within 10 seconds`);
}
