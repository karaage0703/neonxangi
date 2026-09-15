import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";
import { PROFILES, type AgentBackend, type Profile } from "./config.js";

export class PolicyError extends Error {}

export interface Policy {
  version: number;
  filesystem_policy: {
    include_workdir: boolean;
    read_only: string[];
    read_write: string[];
  };
  landlock: { compatibility: "best_effort" | "strict" };
  [key: string]: unknown;
}

export type CapabilityState = "allowed" | "limited" | "blocked";

export interface PolicyCapability {
  id: string;
  label: string;
  state: CapabilityState;
  detail: string;
}

export interface PolicyEndpoint {
  host: string;
  port: number | string;
  access: string;
}

export interface PolicyNetwork {
  name: string;
  endpoints: PolicyEndpoint[];
  binaries: string[];
}

export interface PolicySummary {
  workspace_access: "read-write" | "read-only";
  landlock: "best_effort" | "strict";
  read_only_paths: string[];
  read_write_paths: string[];
  capabilities: PolicyCapability[];
  networks: PolicyNetwork[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePolicyText(text: string, source = "policy"): Policy {
  let value: unknown;
  try {
    value = parse(text) as unknown;
  } catch (error) {
    throw new PolicyError(`unable to parse ${source}: ${String(error)}`);
  }
  if (!isRecord(value) || value.version !== 1) {
    throw new PolicyError("policy must be a mapping with version: 1");
  }
  const filesystem = value.filesystem_policy;
  if (!isRecord(filesystem))
    throw new PolicyError("filesystem_policy is required");
  if (typeof filesystem.include_workdir !== "boolean") {
    throw new PolicyError(
      "filesystem_policy.include_workdir must be a boolean",
    );
  }
  const readOnly = filesystem.read_only;
  const readWrite = filesystem.read_write;
  if (
    !Array.isArray(readOnly) ||
    !readOnly.every((item) => typeof item === "string")
  ) {
    throw new PolicyError("filesystem_policy.read_only must be a list");
  }
  if (
    !Array.isArray(readWrite) ||
    !readWrite.every((item) => typeof item === "string")
  ) {
    throw new PolicyError("filesystem_policy.read_write must be a list");
  }
  if (readWrite.includes("/"))
    throw new PolicyError("filesystem root must never be writable");
  const landlock = value.landlock;
  if (
    !isRecord(landlock) ||
    !["best_effort", "strict"].includes(String(landlock.compatibility))
  ) {
    throw new PolicyError(
      "landlock compatibility must be best_effort or strict",
    );
  }
  return value as unknown as Policy;
}

export function loadPolicy(path: string): Policy {
  try {
    return parsePolicyText(readFileSync(path, "utf8"), path);
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError(`unable to load policy ${path}: ${String(error)}`);
  }
}

export function profilePath(root: string, profile: string): string {
  if (!PROFILES.includes(profile as Profile))
    throw new PolicyError(`unknown profile: ${profile}`);
  return join(root, "blueprint", "profiles", `${profile}.yaml`);
}

export function workspaceIsReadOnly(policy: Policy): boolean {
  return (
    !policy.filesystem_policy.include_workdir &&
    policy.filesystem_policy.read_only.includes("/workspace") &&
    !policy.filesystem_policy.read_write.includes("/workspace")
  );
}

const BACKEND_NETWORK: Record<
  Exclude<AgentBackend, "local-llm">,
  { endpoints: string[]; binaries: string[] }
> = {
  codex: {
    endpoints: [
      "api.openai.com",
      "auth.openai.com",
      "chatgpt.com",
      "ab.chatgpt.com",
    ],
    binaries: [
      "/usr/local/bin/codex",
      "/usr/local/lib/node_modules/@openai/codex/**",
    ],
  },
  "claude-code": {
    endpoints: ["api.anthropic.com"],
    binaries: [
      "/usr/local/bin/claude",
      "/usr/local/lib/node_modules/@anthropic-ai/claude-code/**",
    ],
  },
  "github-copilot": {
    endpoints: ["api.githubcopilot.com"],
    binaries: [
      "/usr/local/bin/copilot",
      "/usr/local/lib/node_modules/@github/copilot/**",
    ],
  },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function policyForBackend(
  policy: Policy,
  backend: AgentBackend,
  localLlmBaseUrl = "http://host.openshell.internal:11434",
): Policy {
  const result = structuredClone(policy);
  const networks = record(result.network_policies);
  if (!networks) throw new PolicyError("network_policies is required");
  delete networks.codex_inference;
  const localEndpoint =
    backend === "local-llm" ? new URL(localLlmBaseUrl) : undefined;
  const selected =
    backend === "local-llm"
      ? {
          endpoints: [localEndpoint!.hostname],
          binaries: ["/usr/local/bin/node"],
        }
      : BACKEND_NETWORK[backend];
  networks.agent_inference = {
    name: `${backend}-inference`,
    endpoints: selected.endpoints.map((host) => ({
      host,
      port: backend === "local-llm" ? Number(localEndpoint!.port) : 443,
      protocol: "rest",
      enforcement: "enforce",
      access: "read-write",
    })),
    binaries: selected.binaries.map((path) => ({ path })),
  };
  for (const value of Object.values(networks)) {
    const section = record(value);
    if (!section || !Array.isArray(section.binaries)) continue;
    const binaries = section.binaries as unknown[];
    const hasCodex = binaries.some(
      (item) => record(item)?.path === "/usr/local/bin/codex",
    );
    if (!hasCodex || section === networks.agent_inference) continue;
    section.binaries = [
      ...binaries.filter(
        (item) => record(item)?.path !== "/usr/local/bin/codex",
      ),
      { path: selected.binaries[0] },
    ];
  }
  return result;
}

function networkSummary(policy: Policy): PolicyNetwork[] {
  const networks = record(policy.network_policies);
  if (!networks) return [];
  return Object.values(networks).flatMap((value) => {
    const section = record(value);
    if (!section) return [];
    const endpoints = Array.isArray(section.endpoints)
      ? section.endpoints.flatMap((value) => {
          const endpoint = record(value);
          if (!endpoint || typeof endpoint.host !== "string") return [];
          return [
            {
              host: endpoint.host,
              port:
                typeof endpoint.port === "number" ||
                typeof endpoint.port === "string"
                  ? endpoint.port
                  : "—",
              access:
                typeof endpoint.access === "string"
                  ? endpoint.access
                  : Array.isArray(endpoint.rules)
                    ? "rules"
                    : "restricted",
            },
          ];
        })
      : [];
    const binaries = Array.isArray(section.binaries)
      ? section.binaries.flatMap((value) => {
          const binary = record(value);
          return typeof binary?.path === "string" ? [binary.path] : [];
        })
      : [];
    return [
      {
        name:
          typeof section.name === "string" ? section.name : "network-policy",
        endpoints,
        binaries,
      },
    ];
  });
}

export function summarizePolicy(
  policy: Policy,
  backend: AgentBackend,
): PolicySummary {
  const networks = networkSummary(policy);
  const networkNames = new Set(networks.map((network) => network.name));
  const github = networks.some((network) =>
    network.endpoints.some((endpoint) =>
      ["github.com", "api.github.com"].includes(endpoint.host),
    ),
  );
  const packages = networkNames.has("package-read");
  const workspaceAccess = workspaceIsReadOnly(policy)
    ? "read-only"
    : "read-write";
  return {
    workspace_access: workspaceAccess,
    landlock: policy.landlock.compatibility,
    read_only_paths: [...policy.filesystem_policy.read_only],
    read_write_paths: [...policy.filesystem_policy.read_write],
    capabilities: [
      {
        id: "workspace",
        label: "Workspace",
        state: workspaceAccess === "read-only" ? "limited" : "allowed",
        detail:
          workspaceAccess === "read-only"
            ? "内容を読めます。変更はできません。"
            : "内容を読み書きできます。",
      },
      {
        id: "backend",
        label: `${backend}との通信`,
        state: "allowed",
        detail: "AI backendの許可済みendpointへ通信できます。",
      },
      {
        id: "backend-web",
        label: backend === "codex" ? "CodexのWeb検索" : "AI backendのWeb機能",
        state: backend === "codex" ? "blocked" : "limited",
        detail:
          backend === "codex"
            ? "OpenAI側のWeb検索、Apps、Browser、plugin、MCPは管理者設定で無効です。"
            : "backend固有のWeb機能はOpenShellの通信先allowlistとは別に確認が必要です。",
      },
      {
        id: "github",
        label: "GitHub",
        state: github ? "limited" : "blocked",
        detail: github
          ? "許可されたendpointへの読み取り通信だけ利用できます。"
          : "GitHubへの通信は許可されていません。",
      },
      {
        id: "packages",
        label: "Package registry",
        state: packages ? "limited" : "blocked",
        detail: packages
          ? "許可されたregistryから読み取れます。公開や書き込みはできません。"
          : "Package registryへの通信は許可されていません。",
      },
      {
        id: "direct-web",
        label: "任意サイトへの直接通信",
        state: "blocked",
        detail: "通信先allowlistにないWebサイトへは直接接続できません。",
      },
      {
        id: "host-secrets",
        label: "Hostのcredential",
        state: "blocked",
        detail:
          "Discord・Slack tokenやhost側の認証ファイルはsandboxへ渡しません。",
      },
      {
        id: "host-operations",
        label: "Host側の操作",
        state: "limited",
        detail:
          "公開されたbridge操作だけ利用でき、副作用のある操作は承認対象です。",
      },
    ],
    networks,
  };
}

export function policyMatchesConfiguration(
  active: Policy,
  configured: Policy,
): boolean {
  const activeReadOnly = new Set(active.filesystem_policy.read_only);
  const activeReadWrite = new Set(active.filesystem_policy.read_write);
  const configuredReadWrite = new Set(configured.filesystem_policy.read_write);
  return (
    active.version === configured.version &&
    active.filesystem_policy.include_workdir ===
      configured.filesystem_policy.include_workdir &&
    configured.filesystem_policy.read_only.every((path) =>
      activeReadOnly.has(path),
    ) &&
    activeReadWrite.size === configuredReadWrite.size &&
    [...configuredReadWrite].every((path) => activeReadWrite.has(path)) &&
    active.landlock.compatibility === configured.landlock.compatibility &&
    isDeepStrictEqual(active.network_policies, configured.network_policies)
  );
}

export function dumpPolicy(policy: unknown): string {
  return stringify(policy, { lineWidth: 0 });
}

export function diffPolicy(current: string, candidate: string): string {
  if (current === candidate) return "";
  const before = current.split(/\r?\n/u);
  const after = candidate.split(/\r?\n/u);
  return [
    "--- active-policy.yaml",
    "+++ candidate-policy.yaml",
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
    "",
  ].join("\n");
}
