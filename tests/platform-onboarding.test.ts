import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "@slack/bolt";
import type { Client, Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeDispatcher } from "../src/bridge.js";
import {
  checkOpenShellForSetup,
  ensureOpenShellForSetup,
  installPinnedOpenShell,
  OPENSHELL_INSTALLER_URL,
} from "../src/openshell-setup.js";
import type { OpenShell } from "../src/openshell.js";
import { DiscordBridge } from "../src/discord-bridge.js";
import {
  aiToolSetupGuide,
  buildPrompt,
  guidedSetup,
  missingBackendGuide,
  prepareWorkspace,
  recommendedWorkspace,
  setupEnvironment,
  SetupPrerequisiteError,
  type DetectedBackend,
} from "../src/onboarding.js";
import { SlackBridge } from "../src/slack-bridge.js";

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

function backend(authenticated: boolean | null = true): DetectedBackend {
  return {
    backend: {
      id: "codex",
      label: "Codex",
      command: "codex",
      authCheck: ["login", "status"],
      authGuide: "codex login",
    },
    executable: "/usr/bin/codex",
    version: "1.0.0",
    authenticated,
  };
}

function dispatcher() {
  const write = vi.fn();
  const dispatch = vi.fn(async () => "completed");
  return {
    value: {
      input: { audit: { write } },
      dispatch,
    } as unknown as BridgeDispatcher,
    write,
    dispatch,
  };
}

describe("AI-guided setup", () => {
  it("checks the supported OpenShell version and a live gateway", () => {
    const requireVersionRange = vi.fn();
    const listSandboxes = vi.fn(() => []);
    const shell = {
      version: vi.fn(() => "openshell 0.0.116"),
      requireVersionRange,
      listSandboxes,
    } as unknown as OpenShell;
    expect(checkOpenShellForSetup(() => shell)).toEqual({
      ready: true,
      version: "openshell 0.0.116",
      detail: "OpenShell gatewayへ接続できます",
    });
    expect(requireVersionRange).toHaveBeenCalledWith("0.0.116", "0.1.0");
    expect(listSandboxes).toHaveBeenCalledOnce();
  });

  it("installs the pinned official OpenShell release and rechecks it", async () => {
    const checks = [
      { ready: false, detail: "OpenShell executable not found" },
      { ready: true, version: "openshell 0.0.116", detail: "ready" },
    ];
    const install = vi.fn(async () => undefined);
    await expect(
      ensureOpenShellForSetup({
        check: () => checks.shift()!,
        install,
        report: vi.fn(),
      }),
    ).resolves.toEqual(expect.objectContaining({ ready: true }));
    expect(install).toHaveBeenCalledOnce();

    let downloaded = "";
    let installedVersion = "";
    await installPinnedOpenShell({
      environment: { PATH: "/bin", DISCORD_TOKEN: "secret" },
      download: async (url) => {
        downloaded = url;
        return "#!/bin/sh\nexit 0\n";
      },
      launch: (_script, environment) => {
        installedVersion = environment.OPENSHELL_VERSION ?? "";
        expect(environment.PATH).toBe("/bin");
        expect(environment.DISCORD_TOKEN).toBeUndefined();
        return 0;
      },
    });
    expect(downloaded).toBe(OPENSHELL_INSTALLER_URL);
    expect(installedVersion).toBe("v0.0.116");
  });

  it("removes platform credentials from the setup environment", () => {
    expect(
      setupEnvironment({
        DISCORD_TOKEN: "secret",
        SLACK_BOT_TOKEN: "secret",
        SAFE: "yes",
      }),
    ).toEqual({ SAFE: "yes" });
  });

  it("uses xangi's shared AI tool setup entrypoint", () => {
    expect(aiToolSetupGuide("claude-code")).toContain(
      "xangi/releases/latest/download/setup-ai-tools.sh) claude-code",
    );
    expect(missingBackendGuide()).toContain(
      "codex / claude-code / github-copilot",
    );
  });

  it("recommends a fresh dedicated workspace instead of an existing one", () => {
    const dir = root();
    expect(recommendedWorkspace(dir)).toBe(join(dir, "neonxangi-workspace"));
    mkdirSync(join(dir, "neonxangi-workspace"));
    expect(recommendedWorkspace(dir)).toBe(join(dir, "neonxangi-workspace-2"));
  });

  it("creates only the selected workspace directory", () => {
    const dir = root();
    const workspace = join(dir, "neonxangi-workspace");
    expect(prepareWorkspace(workspace)).toBe(workspace);
    expect(existsSync(workspace)).toBe(true);
    expect(() => prepareWorkspace(join(dir, "missing", "nested"))).toThrow(
      "parent",
    );
  });

  it("recommends ai-assistant-workspace without exposing existing workspaces", () => {
    const prompt = buildPrompt({
      launcher: "neonxangi",
      recommendedWorkspace: "/new/neonxangi-workspace",
      documentationRoot: "/docs",
      availableBackends: [backend().backend],
    });
    expect(prompt).toContain("一度に一つだけ");
    expect(prompt).toContain("neonxangi setup --apply");
    expect(prompt).toContain("--backend <BACKEND>");
    expect(prompt).toContain("codex: Codex");
    expect(prompt).toContain("xangi setup --apply");
    expect(prompt).toContain("hostへxangiをinstall");
    expect(prompt).toContain("tokenやsecretの値");
    expect(prompt).toContain("karaage0703/ai-assistant-workspace");
    expect(prompt).toContain("最小の空workspace");
    expect(prompt).toContain("既存workspaceは自動検出・列挙せず");
  });

  it("keeps xangi setup inside the sandbox workload", () => {
    const script = readFileSync(
      join(process.cwd(), "blueprint", "start-workload.sh"),
      "utf8",
    );
    expect(script).toContain("/opt/xangi/dist/cli/xangi-main.js setup");
    expect(script).toContain("--workspace /workspace");
    expect(script).toContain("--workspace-mode existing");
    expect(script).toContain('--backend "$AGENT_BACKEND"');
    expect(script).toContain("XDG_CONFIG_HOME=/var/lib/xangi/config");
    const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).toContain("@openai/codex@");
    expect(dockerfile).toContain("@anthropic-ai/claude-code@");
    expect(dockerfile).not.toContain("opencode-ai@");
    expect(dockerfile).toContain("@github/copilot@");
    expect(script).toContain("LOCAL_LLM_BASE_URL");
    expect(script).toContain("LOCAL_LLM_MODEL");
    expect(script).toContain("LOCAL_LLM_UPSTREAM_URL");
    expect(script).toContain("dist/local-llm-relay.js");
  });

  it("enforces disabled Codex hosted network tools at system scope", () => {
    const config = readFileSync(
      join(process.cwd(), "blueprint", "codex-config.toml"),
      "utf8",
    );
    const requirements = readFileSync(
      join(process.cwd(), "blueprint", "codex-requirements.toml"),
      "utf8",
    );
    const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
    expect(config).toContain('web_search = "disabled"');
    expect(requirements).toContain("allowed_web_search_modes = []");
    expect(requirements).toContain("[mcp_servers]");
    expect(requirements).toContain("apps = false");
    expect(requirements).toContain("browser_use = false");
    expect(requirements).toContain("computer_use = false");
    expect(requirements).toContain("plugins = false");
    expect(dockerfile).toContain("/etc/codex/requirements.toml");
  });

  it("uses a temporary instruction file and deletes it after launch", () => {
    let instruction = "";
    let safeEnvironment = false;
    const result = guidedSetup({
      launcher: "neonxangi",
      documentationRoot: process.cwd(),
      backends: [backend()],
      home: root(),
      launch: (_executable, args, _cwd, environment) => {
        const match = /\/tmp\/neonxangi-setup-[^ ]+\/instructions\.md/u.exec(
          args.at(-1) ?? "",
        );
        instruction = match?.[0] ?? "";
        safeEnvironment = !environment.DISCORD_TOKEN;
        expect(existsSync(instruction)).toBe(true);
        return 0;
      },
    });
    expect(result).toContain("Codex");
    expect(safeEnvironment).toBe(true);
    expect(existsSync(instruction)).toBe(false);
  });

  it("rejects missing, unauthenticated, and failed backends", () => {
    expect(() =>
      guidedSetup({
        launcher: "neonxangi",
        documentationRoot: "/docs",
        backends: [],
      }),
    ).toThrow(SetupPrerequisiteError);
    expect(() =>
      guidedSetup({
        launcher: "neonxangi",
        documentationRoot: "/docs",
        backends: [backend(false)],
      }),
    ).toThrow("認証");
    expect(() =>
      guidedSetup({
        launcher: "neonxangi",
        documentationRoot: "/docs",
        backends: [backend()],
        home: root(),
        launch: () => 7,
      }),
    ).toThrow("終了コード7");
  });
});

describe("Discord Gateway policy", () => {
  function client(): Client {
    return {
      on: vi.fn(),
      login: vi.fn(async () => "token"),
      destroy: vi.fn(async () => undefined),
      user: { id: "self" },
    } as unknown as Client;
  }

  function message(overrides: Record<string, unknown> = {}): Message {
    const sent = { edit: vi.fn(async () => undefined) };
    const channel = {
      id: "channel",
      name: "test",
      isThread: () => false,
      isSendable: () => true,
      send: vi.fn(async () => undefined),
    };
    return {
      id: "message",
      guildId: "guild",
      content: "hello",
      author: { id: "user", bot: false, username: "User", displayName: "User" },
      member: null,
      channel,
      mentions: { users: { has: () => false } },
      attachments: new Map(),
      reactions: { cache: { find: () => undefined } },
      react: vi.fn(async () => undefined),
      reply: vi.fn(async () => sent),
      ...overrides,
    } as unknown as Message;
  }

  it("denies channels outside the coarse allowlist", async () => {
    const gateway = dispatcher();
    const bridge = new DiscordBridge({
      dispatcher: gateway.value,
      allowedUsers: new Set(["user"]),
      allowedBots: new Set(),
      allowedChannels: new Set(),
      autoReplyChannels: new Set(),
      botMaxConsecutive: 3,
      quarantineDir: root(),
      client: client(),
    });
    await bridge.processMessage(message());
    expect(gateway.dispatch).not.toHaveBeenCalled();
    expect(gateway.write).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied" }),
    );
  });

  it("dispatches allowlisted auto-reply messages and ignores itself", async () => {
    const gateway = dispatcher();
    const bridge = new DiscordBridge({
      dispatcher: gateway.value,
      allowedUsers: new Set(["user"]),
      allowedBots: new Set(),
      allowedChannels: new Set(["channel"]),
      autoReplyChannels: new Set(["channel"]),
      botMaxConsecutive: 3,
      quarantineDir: root(),
      client: client(),
    });
    await bridge.processMessage(message());
    expect(gateway.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "discord", message: "hello" }),
      expect.any(Function),
    );
    await bridge.processMessage(
      message({
        author: {
          id: "self",
          bot: true,
          username: "self",
          displayName: "self",
        },
      }),
    );
    expect(gateway.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("Slack Gateway policy", () => {
  function app() {
    const postMessage = vi.fn(async () => ({ ts: "response" }));
    const fake = {
      event: vi.fn(),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      client: {
        auth: { test: vi.fn(async () => ({ user_id: "self" })) },
        reactions: {
          add: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
        chat: { postMessage, update: vi.fn(async () => undefined) },
        filesUploadV2: vi.fn(async () => undefined),
      },
    };
    return { value: fake as unknown as App, postMessage };
  }

  it("requires the Slack user/channel allowlist", async () => {
    const gateway = dispatcher();
    const slack = app();
    const bridge = new SlackBridge({
      dispatcher: gateway.value,
      botToken: "test-token",
      appToken: "test-app-token",
      allowedUsers: new Set(),
      allowedChannels: new Set(["channel"]),
      autoReplyChannels: new Set(["channel"]),
      quarantineDir: root(),
      app: slack.value,
    });
    await bridge.processEvent({
      type: "message",
      user: "user",
      channel: "channel",
      ts: "1",
      text: "hello",
    });
    expect(gateway.dispatch).not.toHaveBeenCalled();
  });

  it("streams an allowlisted Socket Mode message into a thread", async () => {
    const gateway = dispatcher();
    const slack = app();
    const bridge = new SlackBridge({
      dispatcher: gateway.value,
      botToken: "test-token",
      appToken: "test-app-token",
      allowedUsers: new Set(["user"]),
      allowedChannels: new Set(["channel"]),
      autoReplyChannels: new Set(["channel"]),
      quarantineDir: root(),
      app: slack.value,
    });
    await bridge.start();
    await bridge.processEvent({
      type: "message",
      user: "user",
      channel: "channel",
      ts: "1",
      text: "hello",
    });
    expect(gateway.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "slack",
        conversation_id: "channel",
      }),
      expect.any(Function),
    );
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "channel", thread_ts: "1" }),
    );
    await bridge.stop();
  });
});
