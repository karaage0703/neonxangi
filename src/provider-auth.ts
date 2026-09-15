import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export class ProviderAuthError extends Error {}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ProviderAuthError(`Codex login情報に${name}がありません`);
  return value;
}

export function codexAuthPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const root = environment.CODEX_HOME
    ? resolve(environment.CODEX_HOME)
    : join(homedir(), ".codex");
  return join(root, "auth.json");
}

export function codexProviderEnvironment(
  path = codexAuthPath(),
): NodeJS.ProcessEnv {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new ProviderAuthError(
      "Codexのlogin情報が見つかりません。先に `codex login` を実行してください",
    );
  }
  if (!info.isFile() || info.isSymbolicLink())
    throw new ProviderAuthError(
      "Codex auth.jsonは通常fileである必要があります",
    );
  if ((info.mode & 0o077) !== 0)
    throw new ProviderAuthError("Codex auth.jsonのpermissionは0600が必要です");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new ProviderAuthError(
      "Codex auth.jsonの所有者が現在userではありません",
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ProviderAuthError("Codex auth.jsonを解析できません");
  }
  const tokens = record(record(parsed).tokens);
  const environment: NodeJS.ProcessEnv = {
    CODEX_AUTH_ACCESS_TOKEN: requiredText(tokens.access_token, "access_token"),
    CODEX_AUTH_REFRESH_TOKEN: requiredText(
      tokens.refresh_token,
      "refresh_token",
    ),
    CODEX_AUTH_ACCOUNT_ID: requiredText(tokens.account_id, "account_id"),
  };
  if (typeof tokens.id_token === "string" && tokens.id_token.trim())
    environment.CODEX_AUTH_ID_TOKEN = tokens.id_token;
  return environment;
}
