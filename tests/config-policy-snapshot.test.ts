import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  defaultConfig,
  loadConfig,
  readSecret,
  saveConfig,
} from "../src/config.js";
import {
  diffPolicy,
  loadPolicy,
  policyMatchesConfiguration,
  policyForBackend,
  profilePath,
  summarizePolicy,
  workspaceIsReadOnly,
} from "../src/policy.js";
import {
  codexProviderEnvironment,
  ProviderAuthError,
} from "../src/provider-auth.js";
import { OpenShell } from "../src/openshell.js";
import {
  createSnapshot,
  restoreSnapshot,
  SnapshotError,
  verifySnapshot,
} from "../src/snapshot.js";
import {
  publicConfig,
  savePublic,
  SettingsError,
  validateConfig,
  validatePublic,
} from "../src/settings.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "neonxangi-test-"));
  roots.push(value);
  return value;
}

describe("configuration and policy", () => {
  it("loads mode-0600 Codex ChatGPT credentials for OpenShell", () => {
    const dir = root();
    const auth = join(dir, "auth.json");
    writeFileSync(
      auth,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "test-access",
          refresh_token: "test-refresh",
          account_id: "test-account",
          id_token: "test-id",
        },
      }),
      { mode: 0o600 },
    );
    expect(Object.keys(codexProviderEnvironment(auth)).sort()).toEqual([
      "CODEX_AUTH_ACCESS_TOKEN",
      "CODEX_AUTH_ACCOUNT_ID",
      "CODEX_AUTH_ID_TOKEN",
      "CODEX_AUTH_REFRESH_TOKEN",
    ]);
    chmodSync(auth, 0o644);
    expect(() => codexProviderEnvironment(auth)).toThrow(ProviderAuthError);
  });

  it("registers named provider credentials from child env without CLI values", () => {
    const dir = root();
    const executable = join(dir, "openshell");
    const argumentsFile = join(dir, "arguments");
    const environmentFile = join(dir, "environment");
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "\${1-}" = "--version" ]; then echo "openshell 0.0.116"; exit 0; fi
printf '%s\\n' "$@" > ${JSON.stringify(argumentsFile)}
if [ -n "\${CODEX_AUTH_ACCESS_TOKEN-}" ]; then echo set > ${JSON.stringify(environmentFile)}; fi
`,
      { mode: 0o700 },
    );
    const shell = new OpenShell(executable);
    shell.ensureProvider({
      name: "codex",
      type: "codex",
      credentialNames: ["CODEX_AUTH_ACCESS_TOKEN"],
      environment: { CODEX_AUTH_ACCESS_TOKEN: "test-secret" },
    });
    let args = readFileSync(argumentsFile, "utf8").split("\n");
    expect(args).toContain("create");
    expect(args).toContain("--credential");
    expect(args).toContain("CODEX_AUTH_ACCESS_TOKEN");
    expect(readFileSync(environmentFile, "utf8").trim()).toBe("set");
    expect(readFileSync(argumentsFile, "utf8")).not.toContain("test-secret");

    shell.create({
      name: "test",
      source: dir,
      policy: join(dir, "policy.yaml"),
      providers: ["codex"],
      autoProviders: true,
      environment: { CODEX_AUTH_ACCESS_TOKEN: "test-secret" },
    });
    args = readFileSync(argumentsFile, "utf8").split("\n");
    expect(args).toContain("--auto-providers");
    expect(args).toContain("--provider");
    expect(args).toContain("codex");
  });

  it("round-trips a mode-0600 config and defaults", () => {
    const dir = root();
    const path = join(dir, "config.json");
    expect(loadConfig(path).runtime.profile).toBe("develop");
    expect(loadConfig(path).runtime.backend).toBe("codex");
    const config = defaultConfig();
    config.runtime.workspace = dir;
    saveConfig(config, path);
    expect(loadConfig(path)).toEqual(config);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reads whole-file and dotenv secrets but rejects loose permissions", () => {
    const dir = root();
    const secret = join(dir, "secret");
    writeFileSync(secret, "TOKEN=value\n", { mode: 0o600 });
    expect(readSecret(secret, "TOKEN")).toBe("value");
    expect(readSecret(secret)).toBe("TOKEN=value");
    chmodSync(secret, 0o644);
    expect(() => readSecret(secret)).toThrow(ConfigError);
  });

  it("limits inference policy to the selected backend", () => {
    const base = loadPolicy(profilePath(process.cwd(), "observe"));
    const claude = policyForBackend(base, "claude-code") as Record<
      string,
      unknown
    >;
    const serialized = JSON.stringify(claude);
    expect(serialized).toContain("api.anthropic.com");
    expect(serialized).toContain("/usr/local/bin/claude");
    expect(serialized).not.toContain("api.openai.com");
    expect(serialized).not.toContain("/usr/local/bin/codex");

    const local = policyForBackend(
      base,
      "local-llm",
      "http://host.openshell.internal:8001",
    );
    const localSerialized = JSON.stringify(local);
    expect(localSerialized).toContain("host.openshell.internal");
    expect(localSerialized).toContain('"port":8001');
    expect(localSerialized).toContain("/usr/local/bin/node");
    expect(localSerialized).not.toContain("api.openai.com");
  });

  it("summarizes effective capabilities without treating backend web as direct web", () => {
    const policy = policyForBackend(
      loadPolicy(profilePath(process.cwd(), "develop")),
      "codex",
    );
    const summary = summarizePolicy(policy, "codex");
    expect(summary.workspace_access).toBe("read-write");
    expect(
      summary.networks.flatMap((network) => network.endpoints),
    ).toContainEqual(expect.objectContaining({ host: "api.openai.com" }));
    expect(summary.capabilities).toContainEqual(
      expect.objectContaining({ id: "backend-web", state: "blocked" }),
    );
    expect(summary.capabilities).toContainEqual(
      expect.objectContaining({ id: "direct-web", state: "blocked" }),
    );
    expect(summary.capabilities).toContainEqual(
      expect.objectContaining({ id: "github", state: "limited" }),
    );
  });

  it("matches OpenShell policies with additional read-only safety paths", () => {
    const configured = policyForBackend(
      loadPolicy(profilePath(process.cwd(), "develop")),
      "codex",
    );
    const active = structuredClone(configured);
    active.filesystem_policy.read_only.push("/var/log", "/dev/urandom");
    expect(policyMatchesConfiguration(active, configured)).toBe(true);
    active.filesystem_policy.read_write.push("/host");
    expect(policyMatchesConfiguration(active, configured)).toBe(false);
  });

  it("validates redacted settings and rejects unknown keys", () => {
    const dir = root();
    const config = defaultConfig();
    config.runtime.workspace = dir;
    expect(
      validateConfig(config).every((check) => check.status === "pass"),
    ).toBe(true);
    const exposed = publicConfig(config);
    expect(JSON.stringify(exposed)).not.toContain("secret-value");
    expect(exposed.secrets).toBeDefined();
    const runtime = exposed.runtime as Record<string, unknown>;
    const editable = {
      runtime: {
        sandbox_name: runtime.sandbox_name,
        workspace: runtime.workspace,
        profile: runtime.profile,
        backend: runtime.backend,
        local_llm_base_url: runtime.local_llm_base_url,
        local_llm_model: runtime.local_llm_model,
      },
      discord: exposed.discord,
      slack: exposed.slack,
    };
    expect(validatePublic(editable, config).valid).toBe(true);
    expect(() =>
      validatePublic({ ...editable, surprise: true }, config),
    ).toThrow(SettingsError);
    const saved = savePublic(editable, join(dir, "saved.json"), config);
    expect(saved.saved).toBe(true);

    const local = structuredClone(editable);
    local.runtime.backend = "local-llm";
    local.runtime.local_llm_base_url = "http://host.openshell.internal:8001";
    local.runtime.local_llm_model = "qwen3.8-27b";
    expect(validatePublic(local, config).valid).toBe(true);
    local.runtime.local_llm_base_url = "http://127.0.0.1:8001";
    expect(validatePublic(local, config).valid).toBe(false);
    const longName = structuredClone(editable);
    longName.runtime.sandbox_name = "12345678901234567890";
    expect(validatePublic(longName, config).valid).toBe(false);
  });

  it("stores platform tokens in managed mode-0600 storage and keeps them redacted", () => {
    const dir = root();
    const target = join(dir, "config.json");
    const config = defaultConfig();
    config.runtime.workspace = dir;
    const exposed = publicConfig(config) as Record<
      string,
      Record<string, unknown>
    >;
    const payload = {
      runtime: exposed.runtime,
      discord: {
        ...exposed.discord,
        enabled: true,
        token: "discord-test-token",
        allowed_users: ["123456789"],
        allowed_channels: ["987654321"],
      },
      slack: {
        ...exposed.slack,
        enabled: true,
        bot_token: "xoxb-test-bot-token",
        app_token: "xapp-test-app-token",
        allowed_users: ["U01234567"],
        allowed_channels: ["C01234567"],
      },
    };
    expect(validatePublic(payload, config).valid).toBe(true);
    const saved = savePublic(payload, target, config);
    const serialized = JSON.stringify(saved);
    expect(serialized).not.toContain("xoxb-test-bot-token");
    expect(serialized).not.toContain("xapp-test-app-token");
    expect(serialized).not.toContain("discord-test-token");
    expect(serialized).not.toContain("slack.env");
    const stored = loadConfig(target);
    expect(statSync(stored.discord.token_file).mode & 0o777).toBe(0o600);
    expect(readSecret(stored.discord.token_file, "DISCORD_TOKEN")).toBe(
      "discord-test-token",
    );
    expect(statSync(stored.slack.token_file).mode & 0o777).toBe(0o600);
    expect(readSecret(stored.slack.token_file, "SLACK_BOT_TOKEN")).toBe(
      "xoxb-test-bot-token",
    );
    expect(readSecret(stored.slack.token_file, "SLACK_APP_TOKEN")).toBe(
      "xapp-test-app-token",
    );
    const redacted = publicConfig(stored) as Record<
      string,
      Record<string, unknown>
    >;
    expect(redacted.slack?.token_file).toBeUndefined();
    expect(
      savePublic(
        {
          runtime: redacted.runtime,
          discord: redacted.discord,
          slack: { ...redacted.slack, bot_token: "", app_token: "" },
        },
        target,
        stored,
      ).saved,
    ).toBe(true);
    expect(() =>
      validatePublic(
        {
          runtime: redacted.runtime,
          discord: redacted.discord,
          slack: { ...redacted.slack, app_token: "xapp-only" },
        },
        stored,
      ),
    ).toThrow("両方");
    expect(() =>
      savePublic(
        {
          runtime: redacted.runtime,
          discord: redacted.discord,
          slack: {
            ...redacted.slack,
            bot_token: "xoxb-new-token",
            app_token: "xapp-new-token",
            allowed_users: [],
            allowed_channels: [],
          },
        },
        target,
        stored,
      ),
    ).toThrow("許可user IDと許可channel ID");
  });

  it("loads every profile and detects read-only workspaces", () => {
    const project = process.cwd();
    for (const name of [
      "observe",
      "develop",
      "research",
      "operate",
      "isolated",
    ]) {
      const path = profilePath(project, name);
      expect(loadPolicy(path).version).toBe(1);
    }
    expect(
      workspaceIsReadOnly(loadPolicy(profilePath(project, "observe"))),
    ).toBe(true);
    expect(
      workspaceIsReadOnly(loadPolicy(profilePath(project, "develop"))),
    ).toBe(false);
    expect(diffPolicy("same", "same")).toBe("");
    expect(diffPolicy("before", "after")).toContain(
      "+++ candidate-policy.yaml",
    );
  });
});

describe("snapshots", () => {
  it("copies state with a manifest and excludes credentials", () => {
    const dir = root();
    const source = join(dir, "state");
    mkdirSync(join(source, "data"), { recursive: true });
    writeFileSync(join(source, "data", "session.json"), "{}");
    writeFileSync(join(source, "capability-private.pem"), "secret");
    const snapshot = createSnapshot(source, join(dir, "snapshots"));
    expect(verifySnapshot(snapshot).files.map((item) => item.path)).toEqual([
      "data/session.json",
    ]);
    const destination = join(dir, "restored");
    restoreSnapshot(snapshot, destination);
    expect(
      readFileSync(join(destination, "data", "session.json"), "utf8"),
    ).toBe("{}");
    expect(() => restoreSnapshot(snapshot, destination)).toThrow("empty");
  });

  it("detects tampering", () => {
    const dir = root();
    const source = join(dir, "state");
    mkdirSync(source);
    writeFileSync(join(source, "value"), "original");
    const snapshot = createSnapshot(source, join(dir, "snapshots"));
    writeFileSync(join(snapshot, "data", "value"), "tampered");
    expect(() => verifySnapshot(snapshot)).toThrow(SnapshotError);
  });
});
