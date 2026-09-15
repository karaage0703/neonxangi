import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenShell } from "./openshell.js";

export const OPENSHELL_INSTALL_VERSION = "0.0.116";
export const OPENSHELL_MAX_VERSION = "0.1.0";
export const OPENSHELL_INSTALLER_URL =
  "https://raw.githubusercontent.com/NVIDIA/OpenShell/d1155aa70042d3e2ee49dbfa15346b108b7c1d92/install.sh";

const PLATFORM_SECRET_ENV = new Set([
  "DISCORD_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "XANGI_REMOTE_PLATFORM_TOKEN",
]);

export interface OpenShellSetupCheck {
  ready: boolean;
  version?: string;
  detail: string;
}

export function checkOpenShellForSetup(
  createShell: () => OpenShell = () => new OpenShell(),
): OpenShellSetupCheck {
  try {
    const shell = createShell();
    const version = shell.version();
    shell.requireVersionRange(OPENSHELL_INSTALL_VERSION, OPENSHELL_MAX_VERSION);
    shell.listSandboxes();
    return { ready: true, version, detail: "OpenShell gatewayへ接続できます" };
  } catch (error) {
    return {
      ready: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installPinnedOpenShell(
  input: {
    download?: (url: string) => Promise<string>;
    launch?: (script: string, environment: NodeJS.ProcessEnv) => number;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> {
  const download =
    input.download ??
    (async (url: string) => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(
          `OpenShell installer download failed: HTTP ${response.status}`,
        );
      return response.text();
    });
  const temporary = mkdtempSync(join(tmpdir(), "neonxangi-openshell-"));
  try {
    const script = join(temporary, "install.sh");
    writeFileSync(script, await download(OPENSHELL_INSTALLER_URL), {
      mode: 0o700,
    });
    chmodSync(script, 0o700);
    const environment = {
      ...Object.fromEntries(
        Object.entries(input.environment ?? process.env).filter(
          ([name]) => !PLATFORM_SECRET_ENV.has(name),
        ),
      ),
      OPENSHELL_VERSION: `v${OPENSHELL_INSTALL_VERSION}`,
    };
    const status = input.launch
      ? input.launch(script, environment)
      : (spawnSync("sh", [script], {
          env: environment,
          stdio: "inherit",
        }).status ?? 1);
    if (status !== 0)
      throw new Error(
        `OpenShell公式installerが終了コード${status}で終了しました`,
      );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function ensureOpenShellForSetup(
  input: {
    check?: () => OpenShellSetupCheck;
    install?: () => Promise<void>;
    report?: (message: string) => void;
  } = {},
): Promise<OpenShellSetupCheck> {
  const check = input.check ?? checkOpenShellForSetup;
  const before = check();
  if (before.ready) return before;

  const report = input.report ?? console.log;
  report(`OpenShell ${OPENSHELL_INSTALL_VERSION}を公式installerで準備します。`);
  report(`現在の状態: ${before.detail}`);
  await (input.install ?? installPinnedOpenShell)();

  const after = check();
  if (!after.ready)
    throw new Error(`OpenShellの準備後確認に失敗しました: ${after.detail}`);
  return after;
}
