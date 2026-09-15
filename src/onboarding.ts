import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { findExecutable } from "./openshell.js";

export class SetupPrerequisiteError extends Error {}

const AI_TOOL_SETUP_URL =
  "https://github.com/karaage0703/xangi/releases/latest/download/setup-ai-tools.sh";

export interface GuidedBackend {
  id: string;
  label: string;
  command: string;
  authCheck: string[];
  authGuide: string;
}

export interface DetectedBackend {
  backend: GuidedBackend;
  executable: string;
  version: string;
  authenticated: boolean | null;
}

export const GUIDED_BACKENDS: GuidedBackend[] = [
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    authCheck: ["login", "status"],
    authGuide: "codex login",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    authCheck: ["auth", "status"],
    authGuide: "claude auth login",
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot CLI",
    command: "copilot",
    authCheck: [],
    authGuide: "copilotを起動して/login",
  },
];

const LOCAL_LLM_BACKEND: GuidedBackend = {
  id: "local-llm",
  label: "Local LLM（OpenAI互換API）",
  command: "",
  authCheck: [],
  authGuide: "",
};

export function aiToolSetupGuide(tool = "codex"): string {
  return `bash <(curl -fsSL ${AI_TOOL_SETUP_URL}) ${tool}`;
}

export function missingBackendGuide(): string {
  return [
    "対応するAI CLIがPATH上にありません。xangiと共通のスクリプトで一つ準備してください:",
    aiToolSetupGuide(),
    "利用可能: codex / claude-code / github-copilot",
    "完了後、もう一度 `neonxangi setup` を実行してください。",
  ].join("\n");
}

const PLATFORM_SECRET_ENV = new Set([
  "DISCORD_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "XANGI_REMOTE_PLATFORM_TOKEN",
]);

export function setupEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !PLATFORM_SECRET_ENV.has(name)),
  );
}

export function detectBackends(): DetectedBackend[] {
  const detected: DetectedBackend[] = [];
  for (const backend of GUIDED_BACKENDS) {
    const executable = findExecutable(backend.command);
    if (!executable) continue;
    const versionResult = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (versionResult.error || versionResult.status !== 0) continue;
    let authenticated: boolean | null = null;
    if (backend.authCheck.length > 0) {
      const result = spawnSync(executable, backend.authCheck, {
        encoding: "utf8",
        timeout: 5000,
      });
      authenticated = !result.error && result.status === 0;
    }
    const version =
      (versionResult.stdout || versionResult.stderr || "unknown")
        .trim()
        .split(/\r?\n/u)[0] ?? "unknown";
    detected.push({
      backend,
      executable: resolve(executable),
      version,
      authenticated,
    });
  }
  return detected;
}

export function recommendedWorkspace(home = homedir()): string {
  const root = resolve(home);
  const base = join(root, "neonxangi-workspace");
  if (!existsSync(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("新規Neon Xangi workspaceの候補を作成できませんでした");
}

export function prepareWorkspace(value: string): string {
  const workspace = resolve(value);
  if (!existsSync(workspace)) {
    const parent = resolve(workspace, "..");
    if (!existsSync(parent) || !statSync(parent).isDirectory())
      throw new Error("workspace parent must be an existing directory");
    mkdirSync(workspace, { mode: 0o700 });
  }
  if (!statSync(workspace).isDirectory())
    throw new Error("workspace must be a directory");
  return workspace;
}

export function buildPrompt(input: {
  launcher: string;
  recommendedWorkspace: string;
  documentationRoot: string;
  availableBackends: GuidedBackend[];
}): string {
  const backendChoices = input.availableBackends
    .map((backend) => `- ${backend.id}: ${backend.label}`)
    .join("\n");
  return `あなたはNeon Xangiの初回セットアップを案内します。
質問・説明・要約は日本語にし、短い質問を一度に一つだけ行ってください。

推奨する新規workspaceの作成先:
- ${JSON.stringify(input.recommendedWorkspace)}

利用可能なAgent backend:
${backendChoices}

必須ルール:
1. 最初に、上記から実際にsandbox内のxangiで使うAgent backendを一つ選んでもらってください。案内を実行中のAIを自動採用せず、利用者の回答を待ってください。
2. 次に、xangi推奨テンプレート https://github.com/karaage0703/ai-assistant-workspace を上記pathへ新規cloneして使う案を推奨してください。利用者が選んだら、clone後のdirectoryをworkspaceとして設定してください。
3. 最小の空workspaceで隔離だけを試す案も選べるようにしてください。その場合は上記pathを使い、\`setup --apply\`にdirectoryを作成させてください。
4. 個人情報や実データを含む既存workspaceは自動検出・列挙せず、利用者が明示的に希望した場合だけ別の絶対pathを受け付けてください。homeを再帰検索しないでください。
5. 次にprofileを一つ選んでもらってください。最初はread-onlyのobserveを推奨し、書込みが必要ならdevelopを案内してください。
6. 決まったらplaceholderを置き換えて次を実行してください:
   ${input.launcher} setup --apply --backend <BACKEND> --workspace <ABSOLUTE_PATH> --profile <PROFILE>
   local-llmを選ぶ場合は、接続先とモデルも確認して --local-llm-base-url http://host.openshell.internal:<PORT> --local-llm-model <MODEL_ID> を追加してください。hostの127.0.0.1はsandboxから参照できないため、host.openshell.internalへ置き換えてください。
7. 設定保存後、利用者自身が別Terminalで\`${input.launcher} settings\`を実行するよう案内してください。
8. tokenやsecretの値を会話へ貼らせず、secret fileをread/cat/grepしないでください。
9. GUI保存後に\`${input.launcher} doctor\`、\`${input.launcher} sandbox create\`、\`${input.launcher} start\`の順で案内してください。sandbox作成時に固定版xangiと選択したbackendの実行環境が内部へ導入され、xangi自身の型付きsetup pathがbackendとworkspaceを検証・保存します。hostへxangiをinstallしたり、hostの\`xangi setup\`を実行したりしないでください。
10. Neon Xangiの担当はOpenShell、Policy、sandbox lifecycle、host側platform credentialです。xangiのAgent、workspace、session、通常設定はxangi自身に委譲されると説明してください。
11. 詳細が必要な時だけ次を読んでください:
   - ${join(input.documentationRoot, "README.md")}
   - ${join(input.documentationRoot, "docs", "usage.md")}

設定の検証と保存はAI自身ではなくNeon Xangi CLI/APIが行います。`;
}

export function launchArgs(
  candidate: DetectedBackend,
  prompt: string,
): string[] {
  if (candidate.backend.id === "antigravity") return ["-i", prompt];
  return [prompt];
}

export function guidedSetup(input: {
  launcher: string;
  documentationRoot: string;
  backends?: DetectedBackend[];
  selected?: DetectedBackend;
  home?: string;
  cwd?: string;
  launch?: (
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => number;
}): string {
  const candidates = input.backends ?? detectBackends();
  if (candidates.length === 0) {
    throw new SetupPrerequisiteError(missingBackendGuide());
  }
  const ready = candidates.filter(
    (candidate) => candidate.authenticated !== false,
  );
  if (ready.length === 0) {
    throw new SetupPrerequisiteError(
      `AI CLIの認証が完了していません。\n${candidates.map((candidate) => `- ${candidate.backend.label}: ${candidate.backend.authGuide}`).join("\n")}`,
    );
  }
  const selected = input.selected ?? ready[0];
  if (!selected || !ready.includes(selected))
    throw new Error("事前確認されていないAI CLIは選択できません");
  const home = resolve(input.home ?? homedir());
  const prompt = buildPrompt({
    launcher: input.launcher,
    recommendedWorkspace: recommendedWorkspace(home),
    documentationRoot: input.documentationRoot,
    availableBackends: [
      ...ready.map((candidate) => candidate.backend),
      LOCAL_LLM_BACKEND,
    ],
  });
  const temporary = mkdtempSync(join(tmpdir(), "neonxangi-setup-"));
  chmodSync(temporary, 0o700);
  try {
    const instruction = join(temporary, "instructions.md");
    writeFileSync(instruction, prompt, { mode: 0o600 });
    const visible = `Neon Xangiのセットアップを始めます。最初に ${instruction} を読み、日本語で一問ずつ案内してください。`;
    const args = launchArgs(selected, visible);
    const code = input.launch
      ? input.launch(selected.executable, args, home, setupEnvironment())
      : (spawnSync(selected.executable, args, {
          cwd: home,
          env: setupEnvironment(),
          stdio: "inherit",
        }).status ?? 1);
    if (code !== 0)
      throw new Error(
        `${selected.backend.label}が終了コード${code}で終了しました`,
      );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return `${selected.backend.label}によるAIガイド付きセットアップが終了しました。`;
}

export function launcherCommand(): string {
  return process.env.NEONXANGI_LAUNCHER ?? "neonxangi";
}
