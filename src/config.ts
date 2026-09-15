import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export class ConfigError extends Error {}

export const PROFILES = [
  "observe",
  "develop",
  "research",
  "operate",
  "isolated",
] as const;
export type Profile = (typeof PROFILES)[number];

export const AGENT_BACKENDS = [
  "codex",
  "claude-code",
  "local-llm",
  "github-copilot",
] as const;
export type AgentBackend = (typeof AGENT_BACKENDS)[number];

export interface DiscordConfig {
  enabled: boolean;
  token_file: string;
  token_key: string;
  allowed_users: string[];
  allowed_bots: string[];
  allowed_channels: string[];
  auto_reply_channels: string[];
  bot_max_consecutive: number;
}

export interface SlackConfig {
  enabled: boolean;
  token_file: string;
  bot_token_key: string;
  app_token_key: string;
  allowed_users: string[];
  allowed_channels: string[];
  auto_reply_channels: string[];
}

export interface RuntimeConfig {
  sandbox_name: string;
  workspace: string;
  profile: Profile;
  backend: AgentBackend;
  local_llm_base_url: string;
  local_llm_model: string;
  xangi_url: string;
  integration_url: string;
  broker_bind: string;
  broker_port: number;
  console_bind: string;
  console_port: number;
  openshell_min_version: string;
}

export interface AppConfig {
  runtime: RuntimeConfig;
  discord: DiscordConfig;
  slack: SlackConfig;
}

export function defaultConfig(): AppConfig {
  return {
    runtime: {
      sandbox_name: "neonxangi",
      workspace: "",
      profile: "develop",
      backend: "codex",
      local_llm_base_url: "http://host.openshell.internal:11434",
      local_llm_model: "",
      xangi_url: "http://127.0.0.1:18789",
      integration_url: "http://127.0.0.1:18790",
      broker_bind: "127.0.0.1",
      broker_port: 18791,
      console_bind: "127.0.0.1",
      console_port: 18792,
      openshell_min_version: "0.0.116",
    },
    discord: {
      enabled: false,
      token_file: "",
      token_key: "",
      allowed_users: [],
      allowed_bots: [],
      allowed_channels: [],
      auto_reply_channels: [],
      bot_max_consecutive: 3,
    },
    slack: {
      enabled: false,
      token_file: "",
      bot_token_key: "SLACK_BOT_TOKEN",
      app_token_key: "SLACK_APP_TOKEN",
      allowed_users: [],
      allowed_channels: [],
      auto_reply_channels: [],
    },
  };
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

export function defaultStateDir(): string {
  return resolve(
    expandHome(
      process.env.NEONXANGI_STATE_DIR ?? join(homedir(), ".neonxangi"),
    ),
  );
}

export function configPath(stateDir = defaultStateDir()): string {
  return join(stateDir, "config.json");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function loadConfig(path = configPath()): AppConfig {
  const defaults = defaultConfig();
  if (!existsSync(path)) return defaults;
  try {
    const raw = record(JSON.parse(readFileSync(path, "utf8")) as unknown);
    const runtime = record(raw.runtime);
    const discord = record(raw.discord);
    const slack = record(raw.slack);
    const profile = text(runtime.profile, defaults.runtime.profile);
    const backend = text(runtime.backend, defaults.runtime.backend);
    if (!PROFILES.includes(profile as Profile)) {
      throw new ConfigError(`unknown policy profile: ${profile}`);
    }
    if (!AGENT_BACKENDS.includes(backend as AgentBackend)) {
      throw new ConfigError(`unknown agent backend: ${backend}`);
    }
    const result: AppConfig = {
      runtime: {
        ...defaults.runtime,
        sandbox_name: text(runtime.sandbox_name, defaults.runtime.sandbox_name),
        workspace: text(runtime.workspace, defaults.runtime.workspace),
        profile: profile as Profile,
        backend: backend as AgentBackend,
        local_llm_base_url: text(
          runtime.local_llm_base_url,
          defaults.runtime.local_llm_base_url,
        ),
        local_llm_model: text(
          runtime.local_llm_model,
          defaults.runtime.local_llm_model,
        ),
        xangi_url: text(runtime.xangi_url, defaults.runtime.xangi_url),
        integration_url: text(
          runtime.integration_url,
          defaults.runtime.integration_url,
        ),
        broker_bind: text(runtime.broker_bind, defaults.runtime.broker_bind),
        broker_port: numberValue(
          runtime.broker_port,
          defaults.runtime.broker_port,
        ),
        console_bind: text(runtime.console_bind, defaults.runtime.console_bind),
        console_port: numberValue(
          runtime.console_port,
          defaults.runtime.console_port,
        ),
        openshell_min_version: text(
          runtime.openshell_min_version,
          defaults.runtime.openshell_min_version,
        ),
      },
      discord: {
        enabled: bool(discord.enabled, false),
        token_file: text(discord.token_file, ""),
        token_key: text(discord.token_key, ""),
        allowed_users: strings(discord.allowed_users),
        allowed_bots: strings(discord.allowed_bots),
        allowed_channels: strings(discord.allowed_channels),
        auto_reply_channels: strings(discord.auto_reply_channels),
        bot_max_consecutive: numberValue(discord.bot_max_consecutive, 3),
      },
      slack: {
        enabled: bool(slack.enabled, false),
        token_file: text(slack.token_file, ""),
        bot_token_key: text(slack.bot_token_key, "SLACK_BOT_TOKEN"),
        app_token_key: text(slack.app_token_key, "SLACK_APP_TOKEN"),
        allowed_users: strings(slack.allowed_users),
        allowed_channels: strings(slack.allowed_channels),
        auto_reply_channels: strings(slack.auto_reply_channels),
      },
    };
    if (result.discord.enabled && !result.discord.token_file) {
      throw new ConfigError(
        "discord.token_file is required when Discord is enabled",
      );
    }
    if (result.slack.enabled && !result.slack.token_file) {
      throw new ConfigError(
        "slack.token_file is required when Slack is enabled",
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`invalid configuration at ${path}: ${String(error)}`);
  }
}

export function saveConfig(config: AppConfig, path = configPath()): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  return path;
}

export function readSecret(path: string, key = ""): string {
  const target = resolve(expandHome(path));
  const mode = statSync(target).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new ConfigError(
      `secret file must not be accessible by group/others: ${target}`,
    );
  }
  let value = readFileSync(target, "utf8").trim();
  if (key) {
    const match = value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(
        (line) =>
          line &&
          !line.startsWith("#") &&
          line.split("=", 1)[0]?.trim() === key,
      );
    if (!match)
      throw new ConfigError(`secret key is missing from file: ${key}`);
    value = match.slice(match.indexOf("=") + 1).trim();
    if (
      value.length >= 2 &&
      value[0] === value.at(-1) &&
      ['"', "'"].includes(value[0] ?? "")
    ) {
      value = value.slice(1, -1);
    }
  }
  if (!value) throw new ConfigError(`secret file is empty: ${target}`);
  return value;
}

export function isAbsoluteDirectory(path: string): boolean {
  try {
    return isAbsolute(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
