#!/bin/bash
set -eu

SANDBOX_ID="${1:?sandbox ID is required}"
WORKSPACE_ID="${2:?workspace ID is required}"
AGENT_BACKEND="${3:?Agent backend is required}"
LOCAL_LLM_BASE_URL="${4:-}"
LOCAL_LLM_MODEL="${5:-}"

case "$AGENT_BACKEND" in
  codex|claude-code|local-llm|github-copilot) ;;
  *) echo "unsupported Agent backend: $AGENT_BACKEND" >&2; exit 2 ;;
esac

unset DISCORD_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN TELEGRAM_BOT_TOKEN
unset LINE_CHANNEL_ACCESS_TOKEN LINE_CHANNEL_SECRET GITHUB_TOKEN GH_TOKEN

export AGENT_BACKEND
if [ "$AGENT_BACKEND" = local-llm ]; then
  [ -n "$LOCAL_LLM_BASE_URL" ] || { echo "Local LLM endpoint is required" >&2; exit 2; }
  [ -n "$LOCAL_LLM_MODEL" ] || { echo "Local LLM model is required" >&2; exit 2; }
  LOCAL_LLM_UPSTREAM_URL="$LOCAL_LLM_BASE_URL"
  LOCAL_LLM_BASE_URL=http://127.0.0.1:18793
  export LOCAL_LLM_BASE_URL LOCAL_LLM_MODEL LOCAL_LLM_UPSTREAM_URL
fi
export WORKSPACE_PATH=/workspace
export DATA_DIR=/var/lib/xangi/data
export XDG_CONFIG_HOME=/var/lib/xangi/config
export XDG_STATE_HOME=/var/lib/xangi/state
export XDG_DATA_HOME=/var/lib/xangi/share
export WEB_CHAT_ENABLED=true
export WEB_CHAT_HOST=127.0.0.1
export WEB_CHAT_PORT=18789
export XANGI_REMOTE_PLATFORM_ENABLED=true
export XANGI_REMOTE_PLATFORM_TOKEN="$(tr -d '-' </proc/sys/kernel/random/uuid)$(tr -d '-' </proc/sys/kernel/random/uuid)"
export XANGI_SELF_LIFECYCLE=off
export RUNTIME_SETTINGS_ENABLED=false
export WORKSPACE_SWITCHING_ENABLED=false

mkdir -p "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME"

if [ "$AGENT_BACKEND" = codex ]; then
  export CODEX_HOME=/var/lib/xangi/codex-home
  mkdir -p "$CODEX_HOME"
  cp /opt/neonxangi/blueprint/codex-config.toml "$CODEX_HOME/config.toml"
  node <<'NODE'
const fs = require('fs');
const path = `${process.env.CODEX_HOME}/auth.json`;
const b64u = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const idToken = [
  b64u({ alg: 'none', typ: 'JWT' }),
  b64u({
    iss: 'https://auth.openai.com',
    aud: 'codex',
    sub: 'neonxangi-openshell',
    email: 'sandbox@neonxangi.local',
    iat: now,
    exp: now + 3600,
  }),
  'placeholder',
].join('.');
for (const name of [
  'CODEX_AUTH_ACCESS_TOKEN',
  'CODEX_AUTH_REFRESH_TOKEN',
  'CODEX_AUTH_ACCOUNT_ID',
]) {
  if (!process.env[name]) throw new Error(`OpenShell did not inject ${name}`);
}
fs.writeFileSync(
  path,
  JSON.stringify(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: process.env.CODEX_AUTH_ACCESS_TOKEN,
        refresh_token: process.env.CODEX_AUTH_REFRESH_TOKEN,
        account_id: process.env.CODEX_AUTH_ACCOUNT_ID,
      },
      last_refresh: new Date().toISOString(),
    },
    null,
    2
  )
);
fs.chmodSync(path, 0o600);
NODE
fi

# xangi is a sandbox workload, not a Neon Xangi host prerequisite. Let xangi's
# typed setup path own its backend/workspace configuration while Neon Xangi owns
# OpenShell, policy, lifecycle, and host platform credentials.
XANGI_CONFIG="$XDG_CONFIG_HOME/xangi/xangi.json"
if [ "$AGENT_BACKEND" = local-llm ]; then
  export XANGI_CONFIG
  node --input-type=module <<'NODE'
import { SetupStore } from "/opt/xangi/dist/setup/store.js";
await new SetupStore(process.env.XANGI_CONFIG).save({
  backend: "local-llm",
  model: process.env.LOCAL_LLM_MODEL,
  workspacePath: "/workspace",
  webChatEnabled: true,
  webChatAccess: "local",
});
NODE
else
  node /opt/xangi/dist/cli/xangi-main.js setup \
    --apply \
    --backend "$AGENT_BACKEND" \
    --workspace /workspace \
    --workspace-mode existing \
    --web-chat-access local
  node /opt/xangi/dist/cli/xangi-main.js setup --complete
fi
export XANGI_SETUP_CONFIG_PATH="$XANGI_CONFIG"
export XANGI_SETUP_STATE_DIR="$DATA_DIR"

RELAY_PID=""
if [ "$AGENT_BACKEND" = local-llm ]; then
  node /opt/neonxangi/dist/local-llm-relay.js "$LOCAL_LLM_UPSTREAM_URL" 18793 \
    >>/var/log/neonxangi/local-llm-relay.log 2>&1 &
  RELAY_PID=$!
  node <<'NODE'
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const response = await fetch("http://127.0.0.1:18793/healthz");
    if (response.ok) process.exit(0);
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
throw new Error("Local LLM relay did not become ready");
NODE
fi

node /opt/xangi/dist/index.js >>/var/log/neonxangi/xangi.log 2>&1 &
XANGI_PID=$!
node /opt/neonxangi/bin/neonxangi-integration.js \
  --bind 0.0.0.0 \
  --port 18790 \
  --sandbox-id "$SANDBOX_ID" \
  --workspace-id "$WORKSPACE_ID" \
  --public-key /var/lib/neonxangi/capability-public.pem \
  --state-dir /var/lib/neonxangi \
  --xangi-url http://127.0.0.1:18789 &
INTEGRATION_PID=$!

cleanup() {
  kill "$XANGI_PID" 2>/dev/null || true
  kill "$INTEGRATION_PID" 2>/dev/null || true
  [ -z "$RELAY_PID" ] || kill "$RELAY_PID" 2>/dev/null || true
  wait "$XANGI_PID" 2>/dev/null || true
  wait "$INTEGRATION_PID" 2>/dev/null || true
  [ -z "$RELAY_PID" ] || wait "$RELAY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ -n "$RELAY_PID" ]; then
  wait -n "$XANGI_PID" "$INTEGRATION_PID" "$RELAY_PID"
else
  wait -n "$XANGI_PID" "$INTEGRATION_PID"
fi
