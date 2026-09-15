import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type {
  AppConfig,
  DiscordConfig,
  RuntimeConfig,
  SlackConfig,
} from "./config.js";
import {
  AGENT_BACKENDS,
  PROFILES,
  defaultConfig,
  expandHome,
  isAbsoluteDirectory,
  readSecret,
  saveConfig,
} from "./config.js";

export class SettingsError extends Error {}

const SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,18}$/u;

export interface Check {
  name: string;
  status: "pass" | "fail";
  detail: string;
}

function secretState(
  path: string,
  key: string,
): { configured: boolean; valid: boolean } {
  if (!path) return { configured: false, valid: false };
  try {
    readSecret(path, key);
    return { configured: true, valid: true };
  } catch {
    return { configured: true, valid: false };
  }
}

export function publicConfig(config: AppConfig): Record<string, unknown> {
  return {
    runtime: {
      sandbox_name: config.runtime.sandbox_name,
      workspace: config.runtime.workspace,
      profile: config.runtime.profile,
      backend: config.runtime.backend,
      local_llm_base_url: config.runtime.local_llm_base_url,
      local_llm_model: config.runtime.local_llm_model,
    },
    discord: {
      enabled: config.discord.enabled,
      allowed_users: [...config.discord.allowed_users],
      allowed_bots: [...config.discord.allowed_bots],
      allowed_channels: [...config.discord.allowed_channels],
      auto_reply_channels: [...config.discord.auto_reply_channels],
      bot_max_consecutive: config.discord.bot_max_consecutive,
    },
    slack: {
      enabled: config.slack.enabled,
      allowed_users: [...config.slack.allowed_users],
      allowed_channels: [...config.slack.allowed_channels],
      auto_reply_channels: [...config.slack.auto_reply_channels],
    },
    secrets: {
      discord: secretState(config.discord.token_file, config.discord.token_key),
      slack_bot: secretState(
        config.slack.token_file,
        config.slack.bot_token_key,
      ),
      slack_app: secretState(
        config.slack.token_file,
        config.slack.app_token_key,
      ),
    },
  };
}

function mapping(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string")
    throw new SettingsError(`${name} must be text`);
  return value.trim();
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new SettingsError(`${name} must be true or false`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SettingsError(`${name} must be an integer`);
  }
  return value;
}

function identifiers(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new SettingsError(`${name} must be a list of IDs`);
  }
  const result = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (result.includes("*"))
    throw new SettingsError(`${name} does not allow wildcards`);
  return result;
}

function rejectUnknown(
  section: string,
  supplied: Record<string, unknown>,
  allowed: Set<string>,
): void {
  const unknown = Object.keys(supplied)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unknown.length > 0)
    throw new SettingsError(
      `unknown ${section} settings: ${unknown.join(", ")}`,
    );
}

export function configFromPublic(
  value: Record<string, unknown>,
  current = defaultConfig(),
): AppConfig {
  const unexpected = Object.keys(value).filter(
    (key) => !["runtime", "discord", "slack"].includes(key),
  );
  if (unexpected.length > 0)
    throw new SettingsError(
      `unknown settings: ${unexpected.sort().join(", ")}`,
    );
  const runtimeValue = mapping(value.runtime ?? {}, "runtime");
  const discordValue = mapping(value.discord ?? {}, "discord");
  const slackValue = mapping(value.slack ?? {}, "slack");
  rejectUnknown(
    "runtime",
    runtimeValue,
    new Set([
      "sandbox_name",
      "workspace",
      "profile",
      "backend",
      "local_llm_base_url",
      "local_llm_model",
    ]),
  );
  rejectUnknown(
    "discord",
    discordValue,
    new Set([
      "enabled",
      "token_file",
      "token_key",
      "token",
      "allowed_users",
      "allowed_bots",
      "allowed_channels",
      "auto_reply_channels",
      "bot_max_consecutive",
    ]),
  );
  rejectUnknown(
    "slack",
    slackValue,
    new Set([
      "enabled",
      "token_file",
      "bot_token_key",
      "app_token_key",
      "bot_token",
      "app_token",
      "allowed_users",
      "allowed_channels",
      "auto_reply_channels",
    ]),
  );
  const runtime: RuntimeConfig = {
    ...current.runtime,
    sandbox_name: text(
      runtimeValue.sandbox_name ?? current.runtime.sandbox_name,
      "sandbox name",
    ),
    workspace: text(
      runtimeValue.workspace ?? current.runtime.workspace,
      "workspace",
    ),
    profile: text(
      runtimeValue.profile ?? current.runtime.profile,
      "profile",
    ) as RuntimeConfig["profile"],
    backend: text(
      runtimeValue.backend ?? current.runtime.backend,
      "backend",
    ) as RuntimeConfig["backend"],
    local_llm_base_url: text(
      runtimeValue.local_llm_base_url ?? current.runtime.local_llm_base_url,
      "local_llm_base_url",
    ),
    local_llm_model: text(
      runtimeValue.local_llm_model ?? current.runtime.local_llm_model,
      "local_llm_model",
    ),
  };
  const discord: DiscordConfig = {
    enabled: booleanValue(
      discordValue.enabled ?? current.discord.enabled,
      "discord.enabled",
    ),
    token_file: text(
      discordValue.token_file ?? current.discord.token_file,
      "discord.token_file",
    ),
    token_key: text(
      discordValue.token_key ?? current.discord.token_key,
      "discord.token_key",
    ),
    allowed_users: identifiers(
      discordValue.allowed_users ?? current.discord.allowed_users,
      "discord.allowed_users",
    ),
    allowed_bots: identifiers(
      discordValue.allowed_bots ?? current.discord.allowed_bots,
      "discord.allowed_bots",
    ),
    allowed_channels: identifiers(
      discordValue.allowed_channels ?? current.discord.allowed_channels,
      "discord.allowed_channels",
    ),
    auto_reply_channels: identifiers(
      discordValue.auto_reply_channels ?? current.discord.auto_reply_channels,
      "discord.auto_reply_channels",
    ),
    bot_max_consecutive: integer(
      discordValue.bot_max_consecutive ?? current.discord.bot_max_consecutive,
      "discord.bot_max_consecutive",
    ),
  };
  const slack: SlackConfig = {
    enabled: booleanValue(
      slackValue.enabled ?? current.slack.enabled,
      "slack.enabled",
    ),
    token_file: text(
      slackValue.token_file ?? current.slack.token_file,
      "slack.token_file",
    ),
    bot_token_key: text(
      slackValue.bot_token_key ?? current.slack.bot_token_key,
      "slack.bot_token_key",
    ),
    app_token_key: text(
      slackValue.app_token_key ?? current.slack.app_token_key,
      "slack.app_token_key",
    ),
    allowed_users: identifiers(
      slackValue.allowed_users ?? current.slack.allowed_users,
      "slack.allowed_users",
    ),
    allowed_channels: identifiers(
      slackValue.allowed_channels ?? current.slack.allowed_channels,
      "slack.allowed_channels",
    ),
    auto_reply_channels: identifiers(
      slackValue.auto_reply_channels ?? current.slack.auto_reply_channels,
      "slack.auto_reply_channels",
    ),
  };
  return { runtime, discord, slack };
}

function discordTokenInput(value: Record<string, unknown>): {
  token: string;
  supplied: boolean;
} {
  const raw = value.token;
  if (raw !== undefined && typeof raw !== "string")
    throw new SettingsError("discord.token must be text");
  const token = (raw ?? "").trim();
  if (!token) return { token: "", supplied: false };
  if (/\s/u.test(token))
    throw new SettingsError("Discord Bot tokenの形式が正しくありません");
  return { token, supplied: true };
}

function slackTokenInput(value: Record<string, unknown>): {
  bot: string;
  app: string;
  supplied: boolean;
} {
  const rawBot = value.bot_token;
  const rawApp = value.app_token;
  if (rawBot !== undefined && typeof rawBot !== "string")
    throw new SettingsError("slack.bot_token must be text");
  if (rawApp !== undefined && typeof rawApp !== "string")
    throw new SettingsError("slack.app_token must be text");
  const bot = (rawBot ?? "").trim();
  const app = (rawApp ?? "").trim();
  if (!bot && !app) return { bot: "", app: "", supplied: false };
  if (!bot || !app)
    throw new SettingsError("Slack Bot tokenとApp tokenを両方入力してください");
  if (!/^xoxb-\S+$/u.test(bot))
    throw new SettingsError("Slack Bot tokenはxoxb-で始まる値が必要です");
  if (!/^xapp-\S+$/u.test(app))
    throw new SettingsError("Slack App tokenはxapp-で始まる値が必要です");
  return { bot, app, supplied: true };
}

function checksWithCredentialInput(
  config: AppConfig,
  discordToken: ReturnType<typeof discordTokenInput>,
  slackTokens: ReturnType<typeof slackTokenInput>,
): Check[] {
  return validateConfig(config).map((check) =>
    check.name === "discord.secret" &&
    config.discord.enabled &&
    discordToken.supplied
      ? {
          name: check.name,
          status: "pass" as const,
          detail: "入力したBot tokenを専用領域へ保存できます",
        }
      : check.name === "slack.secret" &&
          config.slack.enabled &&
          slackTokens.supplied
        ? {
            name: check.name,
            status: "pass" as const,
            detail: "入力したBot/App tokenを専用領域へ保存できます",
          }
        : check,
  );
}

function writeManagedSecret(
  target: string,
  name: string,
  values: Record<string, string>,
): string {
  const secretDirectory = join(dirname(target), "secrets");
  mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
  chmodSync(secretDirectory, 0o700);
  const path = join(secretDirectory, `${name}.env`);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(
      temporary,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}

export function validateConfig(
  config: AppConfig,
  checkSecrets = true,
): Check[] {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, status: ok ? "pass" : "fail", detail });
  };
  check(
    "workspace",
    isAbsoluteDirectory(expandHome(config.runtime.workspace)),
    "existing absolute directory required",
  );
  check(
    "profile",
    PROFILES.includes(config.runtime.profile),
    config.runtime.profile,
  );
  check(
    "backend",
    AGENT_BACKENDS.includes(config.runtime.backend),
    config.runtime.backend,
  );
  let localLlmEndpointOk = true;
  let localLlmEndpointDetail = "not selected";
  if (config.runtime.backend === "local-llm") {
    try {
      const endpoint = new URL(config.runtime.local_llm_base_url);
      localLlmEndpointOk =
        endpoint.protocol === "http:" &&
        endpoint.hostname === "host.openshell.internal" &&
        endpoint.pathname.replace(/\/+$/u, "") === "" &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash &&
        Boolean(endpoint.port);
      localLlmEndpointDetail = localLlmEndpointOk
        ? `${endpoint.hostname}:${endpoint.port}`
        : "http://host.openshell.internal:<port> のみ指定できます";
    } catch {
      localLlmEndpointOk = false;
      localLlmEndpointDetail =
        "http://host.openshell.internal:<port> のみ指定できます";
    }
  }
  check("local_llm.endpoint", localLlmEndpointOk, localLlmEndpointDetail);
  const localLlmModelOk =
    config.runtime.backend !== "local-llm" ||
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(
      config.runtime.local_llm_model,
    );
  check(
    "local_llm.model",
    localLlmModelOk,
    localLlmModelOk
      ? config.runtime.local_llm_model || "not selected"
      : "model IDを指定してください",
  );
  check(
    "sandbox",
    SANDBOX_NAME.test(config.runtime.sandbox_name),
    SANDBOX_NAME.test(config.runtime.sandbox_name)
      ? config.runtime.sandbox_name
      : "1〜19文字の英数字・`.`・`_`・`-`を指定してください",
  );
  check(
    "discord.reply_limit",
    config.discord.bot_max_consecutive >= 1 &&
      config.discord.bot_max_consecutive <= 20,
    "1 to 20",
  );
  const platforms = [
    {
      name: "discord",
      enabled: config.discord.enabled,
      tokenFile: config.discord.token_file,
      keys: [config.discord.token_key],
      users: config.discord.allowed_users,
      channels: config.discord.allowed_channels,
      autoReply: config.discord.auto_reply_channels,
    },
    {
      name: "slack",
      enabled: config.slack.enabled,
      tokenFile: config.slack.token_file,
      keys: [config.slack.bot_token_key, config.slack.app_token_key],
      users: config.slack.allowed_users,
      channels: config.slack.allowed_channels,
      autoReply: config.slack.auto_reply_channels,
    },
  ];
  for (const platform of platforms) {
    if (!platform.enabled) {
      check(platform.name, true, "disabled");
      continue;
    }
    const allowlistOk =
      platform.users.length > 0 && platform.channels.length > 0;
    check(
      `${platform.name}.allowlist`,
      allowlistOk,
      allowlistOk
        ? "許可user IDと許可channel IDを設定済み"
        : "許可user IDと許可channel IDを1件以上入力してください",
    );
    const autoReplyOk = platform.autoReply.every((channel) =>
      platform.channels.includes(channel),
    );
    check(
      `${platform.name}.auto_reply`,
      autoReplyOk,
      autoReplyOk
        ? "自動応答channelは許可範囲内"
        : "自動応答channelは許可channelにも含めてください",
    );
    let secretOk = Boolean(
      platform.tokenFile && isAbsolute(expandHome(platform.tokenFile)),
    );
    let detail = "absolute mode-0600 secret file required";
    if (secretOk && checkSecrets) {
      try {
        for (const key of platform.keys) readSecret(platform.tokenFile, key);
        detail = "secret reference verified; value not exposed";
      } catch (error) {
        secretOk = false;
        detail = String(error instanceof Error ? error.message : error);
      }
    }
    check(`${platform.name}.secret`, secretOk, detail);
  }
  return checks;
}

export function validatePublic(
  value: Record<string, unknown>,
  current?: AppConfig,
): { valid: boolean; checks: Check[]; config: Record<string, unknown> } {
  const discordToken = discordTokenInput(
    mapping(value.discord ?? {}, "discord"),
  );
  const slackTokens = slackTokenInput(mapping(value.slack ?? {}, "slack"));
  const config = configFromPublic(value, current);
  const checks = checksWithCredentialInput(config, discordToken, slackTokens);
  return {
    valid: checks.every((item) => item.status === "pass"),
    checks,
    config: publicConfig(config),
  };
}

export function savePublic(
  value: Record<string, unknown>,
  target: string,
  current?: AppConfig,
): Record<string, unknown> {
  const discordToken = discordTokenInput(
    mapping(value.discord ?? {}, "discord"),
  );
  const slackTokens = slackTokenInput(mapping(value.slack ?? {}, "slack"));
  const config = configFromPublic(value, current);
  const checks = checksWithCredentialInput(config, discordToken, slackTokens);
  const failed = checks.filter((item) => item.status === "fail");
  if (failed.length > 0) {
    throw new SettingsError(
      `設定を保存できません: ${failed.map((item) => `${item.name}（${item.detail}）`).join("、")}`,
    );
  }
  if (config.discord.enabled && discordToken.supplied) {
    config.discord.token_file = writeManagedSecret(target, "discord", {
      DISCORD_TOKEN: discordToken.token,
    });
    config.discord.token_key = "DISCORD_TOKEN";
  }
  if (config.slack.enabled && slackTokens.supplied) {
    config.slack.token_file = writeManagedSecret(target, "slack", {
      SLACK_BOT_TOKEN: slackTokens.bot,
      SLACK_APP_TOKEN: slackTokens.app,
    });
    config.slack.bot_token_key = "SLACK_BOT_TOKEN";
    config.slack.app_token_key = "SLACK_APP_TOKEN";
  }
  const savedChecks = validateConfig(config);
  const savedFailures = savedChecks.filter((item) => item.status === "fail");
  if (savedFailures.length > 0) {
    throw new SettingsError(
      `credentialの保存後検証に失敗しました: ${savedFailures
        .map((item) => item.name)
        .join(", ")}`,
    );
  }
  saveConfig(config, target);
  return {
    saved: true,
    restart_required: true,
    config: publicConfig(config),
    checks: savedChecks,
  };
}
