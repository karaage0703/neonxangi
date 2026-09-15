import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  configPath,
  AGENT_BACKENDS,
  defaultConfig,
  defaultStateDir,
  loadConfig,
  PROFILES,
  saveConfig,
  type AppConfig,
  type AgentBackend,
  type Profile,
} from "./config.js";
import {
  doctor,
  ensureHostIdentity,
  projectRoot,
  serveHost,
  serveSettings,
  startDaemon,
  status,
  stopDaemon,
} from "./controller.js";
import {
  guidedSetup,
  launcherCommand,
  prepareWorkspace,
} from "./onboarding.js";
import { OpenShell, OpenShellError } from "./openshell.js";
import { ensureOpenShellForSetup } from "./openshell-setup.js";
import { codexProviderEnvironment } from "./provider-auth.js";
import {
  diffPolicy,
  dumpPolicy,
  loadPolicy,
  policyForBackend,
  profilePath,
  workspaceIsReadOnly,
} from "./policy.js";
import { validateConfig } from "./settings.js";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "./snapshot.js";
import { updateInstallation } from "./update.js";

const VERSION = "0.1.0";

class Arguments {
  private readonly values = new Map<string, string[]>();
  readonly positionals: string[] = [];

  constructor(args: string[]) {
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index]!;
      if (!value.startsWith("--")) {
        this.positionals.push(value);
        continue;
      }
      const [rawName, inline] = value.slice(2).split(/=(.*)/su, 2);
      const name = rawName!;
      if (inline !== undefined) {
        this.add(name, inline);
      } else if (args[index + 1] && !args[index + 1]!.startsWith("--")) {
        this.add(name, args[(index += 1)]!);
      } else {
        this.add(name, "true");
      }
    }
  }

  private add(name: string, value: string): void {
    this.values.set(name, [...(this.values.get(name) ?? []), value]);
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  one(name: string, fallback?: string): string | undefined {
    const values = this.values.get(name);
    return values?.at(-1) ?? fallback;
  }

  many(name: string): string[] {
    return this.values.get(name) ?? [];
  }

  integer(name: string, fallback: number): number {
    const raw = this.one(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value))
      throw new Error(`--${name} must be an integer`);
    return value;
  }
}

function required(value: string | undefined, flag: string): string {
  if (!value || value === "true") throw new Error(`${flag} is required`);
  return value;
}

function profile(value: string | undefined, fallback: Profile): Profile {
  const selected = value ?? fallback;
  if (!PROFILES.includes(selected as Profile))
    throw new Error(`unknown profile: ${selected}`);
  return selected as Profile;
}

function backend(
  value: string | undefined,
  fallback: AgentBackend,
): AgentBackend {
  const selected = value ?? fallback;
  if (!AGENT_BACKENDS.includes(selected as AgentBackend))
    throw new Error(`unknown agent backend: ${selected}`);
  return selected as AgentBackend;
}

function providerForBackend(value: AgentBackend): string | undefined {
  if (value === "local-llm") return undefined;
  return value === "claude-code"
    ? "claude"
    : value === "github-copilot"
      ? "copilot"
      : value;
}

function configTarget(args: Arguments): string {
  return resolve(args.one("config") ?? configPath());
}

function load(args: Arguments): [AppConfig, string] {
  const target = configTarget(args);
  return [loadConfig(target), target];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sandboxCreate(input: {
  config: AppConfig;
  stateDir: string;
  replaceExisting?: boolean;
  restoreArchive?: string;
  shell?: OpenShell;
}): void {
  const shell = input.shell ?? new OpenShell();
  shell.requireVersion(input.config.runtime.openshell_min_version);
  const root = projectRoot();
  const policyFile = profilePath(root, input.config.runtime.profile);
  const finalPolicy = loadPolicy(policyFile);
  const readOnlyWorkspace = workspaceIsReadOnly(finalPolicy);
  const [, publicKey] = ensureHostIdentity(input.stateDir);
  const existing = new Set(
    shell.listSandboxes().map((item) => String(item.name ?? "")),
  );
  if (existing.has(input.config.runtime.sandbox_name)) {
    if (!input.replaceExisting)
      throw new OpenShellError(
        `sandbox already exists: ${input.config.runtime.sandbox_name}`,
      );
    shell.delete(input.config.runtime.sandbox_name);
  }
  const workspace = resolve(input.config.runtime.workspace);
  let providerEnvironment: NodeJS.ProcessEnv | undefined;
  if (input.config.runtime.backend === "codex") {
    const credentials = codexProviderEnvironment();
    providerEnvironment = { ...process.env, ...credentials };
    shell.ensureProvider({
      name: "codex",
      type: "codex",
      credentialNames: Object.keys(credentials),
      environment: providerEnvironment,
    });
  }
  const temporary = mkdtempSync(join(tmpdir(), "neonxangi-policy-"));
  try {
    const effectivePolicyFile = join(temporary, "effective-policy.yaml");
    writeFileSync(
      effectivePolicyFile,
      dumpPolicy(
        policyForBackend(
          finalPolicy,
          input.config.runtime.backend,
          input.config.runtime.local_llm_base_url,
        ),
      ),
      { mode: 0o600 },
    );
    let source = root;
    let uploads: Array<[string, string]> = [
      [workspace, "/workspace"],
      [publicKey, "/var/lib/neonxangi/capability-public.pem"],
    ];
    if (readOnlyWorkspace) {
      source = join(temporary, "build-context");
      cpSync(root, source, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (path) => {
          const relative = path.slice(root.length).replace(/^\//u, "");
          if (!relative) return true;
          const parts = relative.split("/");
          return !parts.some((part) =>
            [
              ".git",
              ".github",
              ".neonxangi",
              ".env",
              ".venv",
              ".coverage",
              ".pytest_cache",
              "__pycache__",
              "node_modules",
              "dist",
              "coverage",
              "tests",
            ].includes(part),
          );
        },
      });
      const seed = join(source, ".neonxangi-workspace-seed");
      rmSync(seed, { recursive: true, force: true });
      cpSync(workspace, seed, { recursive: true, verbatimSymlinks: true });
      if (readdirSync(seed).length === 0)
        writeFileSync(join(seed, ".gitkeep"), "");
      uploads = [[publicKey, "/var/lib/neonxangi/capability-public.pem"]];
    }
    try {
      const provider = providerForBackend(input.config.runtime.backend);
      shell.create({
        name: input.config.runtime.sandbox_name,
        source,
        policy: effectivePolicyFile,
        providers: provider ? [provider] : [],
        uploads,
        autoProviders: !["codex", "local-llm"].includes(
          input.config.runtime.backend,
        ),
        environment: providerEnvironment ?? process.env,
      });
    } catch (error) {
      try {
        shell.delete(input.config.runtime.sandbox_name);
      } catch {
        // Preserve the original create error.
      }
      throw error;
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (input.restoreArchive) {
    const remoteRoot = `/var/log/neonxangi/transfer-${randomUUID().replaceAll("-", "")}`;
    const remoteArchive = `${remoteRoot}/state-restore.tar.gz`;
    shell.exec(input.config.runtime.sandbox_name, [
      "mkdir",
      "-m",
      "700",
      remoteRoot,
    ]);
    try {
      shell.upload(
        input.config.runtime.sandbox_name,
        input.restoreArchive,
        remoteArchive,
      );
      shell.exec(input.config.runtime.sandbox_name, [
        "sh",
        "-lc",
        `cd ${shellQuote(remoteRoot)} && tar -xzf state-restore.tar.gz && tar -C /var/lib/xangi -xzf .neonxangi-xangi.tar.gz && tar -C /var/lib/neonxangi -xzf .neonxangi-integration.tar.gz`,
      ]);
    } finally {
      shell.exec(
        input.config.runtime.sandbox_name,
        ["rm", "-rf", remoteRoot],
        30_000,
      );
    }
  }
  shell.exec(input.config.runtime.sandbox_name, [
    "sh",
    "-lc",
    `nohup /opt/neonxangi/blueprint/start-workload.sh ${shellQuote(input.config.runtime.sandbox_name)} ${shellQuote(basename(workspace))} ${shellQuote(input.config.runtime.backend)} ${shellQuote(input.config.runtime.local_llm_base_url)} ${shellQuote(input.config.runtime.local_llm_model)} >/var/log/neonxangi/workload.log 2>&1 &`,
  ]);
}

function downloadSandboxState(
  shell: OpenShell,
  sandboxName: string,
  destination: string,
): void {
  const remoteRoot = `/var/log/neonxangi/transfer-${randomUUID().replaceAll("-", "")}`;
  const remoteArchive = `${remoteRoot}/state-snapshot.tar.gz`;
  shell.exec(sandboxName, ["mkdir", "-m", "700", remoteRoot]);
  shell.exec(sandboxName, [
    "sh",
    "-lc",
    `tar -C /var/lib/xangi -czf ${shellQuote(`${remoteRoot}/.neonxangi-xangi.tar.gz`)} --exclude='*.lock' --exclude='*.pid' --exclude='*.sock' --exclude='tool-server-port' data && tar -C /var/lib/neonxangi -czf ${shellQuote(`${remoteRoot}/.neonxangi-integration.tar.gz`)} --exclude='*.lock' --exclude='*.pid' --exclude='*.sock' --exclude='capability-public.pem' . && tar -C ${shellQuote(remoteRoot)} -czf ${shellQuote(remoteArchive)} .neonxangi-xangi.tar.gz .neonxangi-integration.tar.gz`,
  ]);
  try {
    const encoded = shell
      .exec(sandboxName, ["base64", "-w", "0", remoteArchive], 300_000)
      .stdout.trim();
    const data = Buffer.from(encoded, "base64");
    if (
      !encoded ||
      data.toString("base64").replaceAll("=", "") !==
        encoded.replaceAll(/\s|=/gu, "")
    ) {
      throw new OpenShellError(
        "sandbox snapshot transfer returned invalid base64",
      );
    }
    writeFileSync(destination, data, { mode: 0o600 });
  } finally {
    shell.exec(sandboxName, ["rm", "-rf", remoteRoot], 30_000);
  }
}

function help(): void {
  console.log(
    `Neon Xangi ${VERSION}\n\nUsage: neonxangi <command> [options]\n\nCommands:\n  setup        Start AI-guided setup\n  onboard      Write host configuration and identity\n  settings     Open the local settings Console\n  update       Install the latest managed release\n  doctor       Check prerequisites\n  status       Show runtime status\n  start|serve|stop|logs|connect\n  sandbox create|delete|rebuild\n  policy show|diff|apply\n  snapshot|restore|uninstall`,
  );
}

async function run(argv: string[]): Promise<number> {
  const [command, maybeSubcommand, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    help();
    return 0;
  }
  if (command === "--version") {
    console.log(`neonxangi ${VERSION}`);
    return 0;
  }
  if (command === "update") {
    updateInstallation(projectRoot());
    return 0;
  }
  const nested = ["sandbox", "policy"].includes(command);
  const args = new Arguments(
    nested
      ? rest
      : [maybeSubcommand, ...rest].filter(
          (item): item is string => item !== undefined,
        ),
  );
  const subcommand = nested ? maybeSubcommand : undefined;

  if (command === "setup") {
    const target = configTarget(args);
    if (!args.has("apply")) {
      if (
        args.has("workspace") ||
        args.has("config") ||
        args.has("profile") ||
        args.has("backend") ||
        args.has("sandbox-name")
      ) {
        throw new Error("setup options require --apply");
      }
      const openshell = await ensureOpenShellForSetup();
      console.log(`${openshell.version}: version・gateway確認済み`);
      console.log(
        guidedSetup({
          launcher: launcherCommand(),
          documentationRoot: projectRoot(),
        }),
      );
      return 0;
    }
    const workspace = prepareWorkspace(
      required(args.one("workspace"), "setup --apply --workspace"),
    );
    const config = loadConfig(target);
    config.runtime.workspace = workspace;
    config.runtime.profile = profile(args.one("profile"), "observe");
    config.runtime.backend = backend(
      required(args.one("backend"), "setup --apply --backend"),
      "codex",
    );
    config.runtime.local_llm_base_url = args.one(
      "local-llm-base-url",
      config.runtime.local_llm_base_url,
    )!;
    config.runtime.local_llm_model = args.one(
      "local-llm-model",
      config.runtime.local_llm_model,
    )!;
    config.runtime.sandbox_name = args.one("sandbox-name", "neonxangi")!;
    const failed = validateConfig(config, false).filter(
      (check) => check.status === "fail",
    );
    if (failed.length > 0)
      throw new Error(
        `setup validation failed: ${failed.map((item) => item.name).join(", ")}`,
      );
    saveConfig(config, target);
    ensureHostIdentity(resolve(target, ".."));
    console.log(`設定を保存しました: ${target}`);
    console.log(
      "次に `neonxangi settings` でDiscord/Slackとallowlistを確認してください。",
    );
    return 0;
  }

  if (command === "onboard") {
    const workspace = resolve(required(args.one("workspace"), "--workspace"));
    if (!existsSync(workspace) || !statSync(workspace).isDirectory())
      throw new Error("workspace must be an existing directory");
    const discordTokenFile = args.one("discord-token-file", "")!;
    const slackTokenFile = args.one("slack-token-file", "")!;
    if (
      discordTokenFile &&
      (args.many("discord-user").length === 0 ||
        args.many("discord-channel").length === 0)
    ) {
      throw new Error(
        "Discord requires at least one explicit user and channel allowlist entry",
      );
    }
    if (
      slackTokenFile &&
      (args.many("slack-user").length === 0 ||
        args.many("slack-channel").length === 0)
    ) {
      throw new Error(
        "Slack requires at least one explicit user and channel allowlist entry",
      );
    }
    const limit = args.integer("discord-bot-max-consecutive", 3);
    if (limit < 1)
      throw new Error("Discord bot reply limit must be at least 1");
    const config = defaultConfig();
    config.runtime = {
      ...config.runtime,
      sandbox_name: args.one("sandbox-name", "neonxangi")!,
      workspace,
      profile: profile(args.one("profile"), "develop"),
      backend: backend(args.one("backend"), "codex"),
      local_llm_base_url: args.one(
        "local-llm-base-url",
        config.runtime.local_llm_base_url,
      )!,
      local_llm_model: args.one(
        "local-llm-model",
        config.runtime.local_llm_model,
      )!,
    };
    config.discord = {
      enabled: Boolean(discordTokenFile),
      token_file: discordTokenFile,
      token_key: args.one("discord-token-key", "")!,
      allowed_users: args.many("discord-user"),
      allowed_bots: args.many("discord-bot"),
      allowed_channels: args.many("discord-channel"),
      auto_reply_channels: args.many("discord-auto-reply-channel"),
      bot_max_consecutive: limit,
    };
    config.slack = {
      enabled: Boolean(slackTokenFile),
      token_file: slackTokenFile,
      bot_token_key: args.one("slack-bot-token-key", "SLACK_BOT_TOKEN")!,
      app_token_key: args.one("slack-app-token-key", "SLACK_APP_TOKEN")!,
      allowed_users: args.many("slack-user"),
      allowed_channels: args.many("slack-channel"),
      auto_reply_channels: args.many("slack-auto-reply-channel"),
    };
    const target = saveConfig(config, configTarget(args));
    ensureHostIdentity(resolve(target, ".."));
    console.log(target);
    return 0;
  }

  if (command === "snapshot") {
    const source = resolve(args.one("source") ?? defaultStateDir());
    const destination = resolve(
      args.one("destination") ?? join(defaultStateDir(), "snapshots"),
    );
    const result = createSnapshot(source, destination);
    verifySnapshot(result);
    console.log(result);
    return 0;
  }
  if (command === "restore") {
    const [snapshot, destination] = args.positionals;
    restoreSnapshot(
      resolve(required(snapshot, "snapshot")),
      resolve(required(destination, "destination")),
    );
    console.log(resolve(destination!));
    return 0;
  }

  const [config, target] = load(args);
  const stateDir = resolve(target, "..");
  if (command === "settings") {
    await serveSettings(target, stateDir, !args.has("no-open"));
    return 0;
  }
  if (command === "doctor") {
    const checks = doctor(config, projectRoot(), stateDir);
    console.log(JSON.stringify({ checks }, null, 2));
    return checks.some((check) => check.status === "fail") ? 1 : 0;
  }
  if (command === "status") {
    console.log(JSON.stringify(await status(config), null, 2));
    return 0;
  }
  if (command === "serve") {
    await serveHost(config, stateDir, target);
    return 0;
  }
  if (command === "start") {
    const failed = doctor(config, projectRoot(), stateDir).filter(
      (check) => check.status === "fail",
    );
    if (failed.length > 0) {
      console.error(
        JSON.stringify({ error: "doctor failed", checks: failed }, null, 2),
      );
      return 1;
    }
    console.log(await startDaemon(target, stateDir));
    return 0;
  }
  if (command === "stop") {
    console.log(await stopDaemon(stateDir));
    return 0;
  }
  if (command === "logs") {
    const log = join(stateDir, "host.log");
    console.log(
      existsSync(log)
        ? readFileSync(log, "utf8").split(/\r?\n/u).slice(-201, -1).join("\n")
        : "",
    );
    return 0;
  }
  if (command === "connect")
    return new OpenShell().connect(config.runtime.sandbox_name);
  if (command === "sandbox") {
    if (subcommand === "create") sandboxCreate({ config, stateDir });
    else if (subcommand === "delete") {
      if (!args.has("yes")) throw new Error("sandbox delete requires --yes");
      new OpenShell().delete(config.runtime.sandbox_name);
    } else if (subcommand === "rebuild") {
      if (!args.has("yes")) throw new Error("sandbox rebuild requires --yes");
      const shell = new OpenShell();
      const temporary = mkdtempSync(join(tmpdir(), "neonxangi-rebuild-"));
      try {
        const archive = join(temporary, "sandbox-state.tar.gz");
        downloadSandboxState(shell, config.runtime.sandbox_name, archive);
        const snapshot = createSnapshot(stateDir, join(stateDir, "snapshots"), [
          [archive, "sandbox/state.tar.gz"],
        ]);
        sandboxCreate({
          config,
          stateDir,
          replaceExisting: true,
          restoreArchive: join(snapshot, "data", "sandbox", "state.tar.gz"),
          shell,
        });
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    } else throw new Error("sandbox requires create, delete, or rebuild");
    return 0;
  }
  if (command === "policy") {
    const selected = profile(args.one("profile"), config.runtime.profile);
    const candidate = dumpPolicy(
      policyForBackend(
        loadPolicy(profilePath(projectRoot(), selected)),
        config.runtime.backend,
        config.runtime.local_llm_base_url,
      ),
    );
    if (subcommand === "show") process.stdout.write(candidate);
    else if (subcommand === "diff")
      console.log(
        diffPolicy(
          new OpenShell().policyGet(config.runtime.sandbox_name),
          candidate,
        ),
      );
    else if (subcommand === "apply") {
      if (!args.has("yes"))
        throw new Error(
          "policy apply requires --yes after reviewing policy diff",
        );
      const temporary = mkdtempSync(join(tmpdir(), "neonxangi-policy-apply-"));
      try {
        const path = join(temporary, "policy.yaml");
        writeFileSync(path, candidate, { mode: 0o600 });
        new OpenShell().policySet(config.runtime.sandbox_name, path);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
      config.runtime.profile = selected;
      saveConfig(config, target);
    } else throw new Error("policy requires show, diff, or apply");
    return 0;
  }
  if (command === "uninstall") {
    if (!args.has("yes")) throw new Error("uninstall requires --yes");
    try {
      await stopDaemon(stateDir);
    } catch {
      // Stopping is best-effort during uninstall.
    }
    if (args.has("keep-credentials")) {
      for (const item of readdirSync(stateDir)) {
        if (item !== "keys")
          rmSync(join(stateDir, item), { recursive: true, force: true });
      }
    } else rmSync(stateDir, { recursive: true, force: true });
    return 0;
  }
  throw new Error(`unsupported command: ${command}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await run(argv);
  } catch (error) {
    console.error(
      `neonxangi: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
