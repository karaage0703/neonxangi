# Usage

> [!CAUTION]
> Neon Xangi is experimental. Begin with disposable credentials and a non-sensitive test workspace. Do not treat successful setup or smoke tests as proof of security.

[日本語](../usage.md)

## AI-guided setup

Normal installation is one line. The installer downloads the platform-specific managed bundle and its checksum from GitHub Releases, then installs `~/.local/bin/neonxangi`.

```bash
curl -fsSL https://raw.githubusercontent.com/karaage0703/neonxangi/main/install.sh | sh
```

First prepare `codex`, `claude-code`, or `github-copilot` with xangi's shared `setup-ai-tools.sh`. `neonxangi setup` detects authenticated supported CLIs on `PATH` and starts its guided conversation. The first choice is the AI backend that xangi will actually run inside the sandbox. Setup then recommends cloning [ai-assistant-workspace](https://github.com/karaage0703/ai-assistant-workspace) into an unused `~/neonxangi-workspace` path (with a numeric suffix when needed). An empty test workspace is also available; the typed `neonxangi setup --apply` path creates that directory. Neon Xangi does not search for existing workspaces containing personal or operational data and uses one only when the user explicitly supplies it. The initial profile is the read-only `observe` profile.

xangi is not installed on the host. Neon Xangi puts a version-pinned xangi build and the supported AI CLIs in the Blueprint sandbox image. On the first workload start, regular backends use xangi's typed `setup --apply`; Local LLM writes the equivalent configuration through xangi's typed setup store. Its configuration is stored in the dedicated writable `/var/lib/xangi` state and remains separate from every host xangi installation.

Managed bundles include the Node.js runtime and a pinned OpenShell CLI. Node.js 22.16 or newer, npm, and a separate OpenShell binary are required only when developing from a source checkout. Users do not enter bundle paths, checksums, or runtime paths.

When Codex is selected, sandbox creation reads the host's mode-0600 `~/.codex/auth.json` after verifying its owner and registers its OAuth credentials with the OpenShell provider. Values are absent from Neon Xangi configuration, CLI arguments, UI, and logs; they reach the gateway only through the short-lived OpenShell child process environment. The sandbox receives OpenShell placeholders rather than the real values.

Detailed instructions live in a mode-0600 temporary file that is deleted when the AI process exits. Only its path and a short starting prompt are shown to the agent. Never put platform tokens or secret values in the conversation or command arguments. The guide runs on the host before the OpenShell sandbox exists, so it is not an OS-enforced credential boundary. Add platform credentials later in the settings UI.

```bash
neonxangi setup
neonxangi settings
```

If no AI CLI is available, or you prefer not to use one, begin with `neonxangi settings`.

## Update

`neonxangi update` downloads and verifies the latest managed bundle, checksum, and installer before switching versions. Configuration, credentials, and snapshots remain outside the versioned application directory. The command does not restart a running host; inspect its status, then run `neonxangi stop` and `neonxangi start` after the update. It exits successfully without changes when the latest version is already active.

```bash
neonxangi update
```

## Settings Console

`neonxangi settings` starts the loopback Console and automatically opens an authenticated browser even before a sandbox exists. Normal use requires no management-token copy or input. Only a manually opened root URL shows a recovery-token field with an explanation and path. The UI supports:

- workspace, profile, and sandbox name
- Discord/Slack enablement, tokens, and user/channel allowlists
- user, bot, channel, and auto-reply allowlists
- pre-save validation, a redacted complete configuration, and Doctor results
- runtime status, policy, approvals, and audit data after startup

Tokens entered in the Console are stored under Neon Xangi's private `secrets/` directory with mode 0600 and are never returned by the API or UI. A blank token field preserves an existing value. Changes are not hot-applied to a running Gateway. Review the restart-required notice before running `neonxangi stop` and `neonxangi start`.

## Onboard (automation and manual CLI)

`neonxangi onboard` is a low-level automation interface. It writes mode-0600 JSON configuration and generates an Ed25519 signing key plus Console token. Only this advanced path accepts an absolute path to an existing secret file. Normal setup accepts tokens directly in `neonxangi settings`.

To use an existing mode-0600 xangi `.env` instead of a token-only file, pass its path to `--discord-token-file` and add `--discord-token-key DISCORD_TOKEN`. Neon Xangi reads only that key and does not copy the token value into its configuration.

The supported workload is one xangi instance using Codex, Claude Code, xangi Local LLM, or GitHub Copilot CLI; one workspace; and Discord/Slack host Gateways. Local LLM requires an endpoint in `http://host.openshell.internal:<port>` form and a model ID; only that host and port are added to the policy. A sandbox-local loopback relay forwards only `/v1/models`, `/v1/chat/completions`, `/api/tags`, and `/api/chat` to that fixed endpoint. Cursor, Grok, and Antigravity are not offered yet because OpenShell does not currently list them as supported sandbox agents. Start without a platform connection to validate local boundaries first.

The Discord Gateway accepts only allowlisted user/channel combinations and responds to DMs, bot mentions, allowlisted thread replies, or channels explicitly named by `--discord-auto-reply-channel`. Bot messages are denied by default. For bot-to-bot testing, explicitly allow a peer with `onboard --discord-bot BOT_ID`. The Gateway always ignores its own messages and stops replying to the same bot after `--discord-bot-max-consecutive` consecutive messages (default 3). Wildcard bot access is not supported.

The Slack Gateway uses Socket Mode. `--slack-token-file` points to a mode-0600 dotenv containing `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`; every user and channel must be explicitly listed. Add only intentionally mention-free channels to `--slack-auto-reply-channel`. DMs, app mentions, and allowlisted thread replies are accepted.

Both Gateways add an eyes reaction at receipt, render thinking/tool/text updates from xangi's SSE stream, and remove the reaction at completion. Raw platform tokens exist only in the host process. The sandbox receives only a random per-start Remote Platform Adapter secret.

## Profiles

- `observe`: workspace read-only; no general external network policy.
- `develop`: workspace read/write; package registries and GitHub reads are allowed. Pushes still require the host Broker and approval.
- `research`: workspace read-only; only named public research endpoints are allowed.
- `operate`: workspace read/write with strict Landlock compatibility; side effects must traverse the Broker.
- `isolated`: disposable workspace with strict Landlock and no general outbound access.

Profiles declare the permitted job, not a single increasing security level.

## Commands

```text
neonxangi doctor
neonxangi setup [--apply --backend BACKEND --workspace PATH --profile PROFILE]
  [--local-llm-base-url URL --local-llm-model MODEL]
neonxangi settings [--no-open]
neonxangi update
neonxangi onboard
neonxangi sandbox create|delete|rebuild
neonxangi start|status|logs|stop|connect
neonxangi policy show|diff|apply
neonxangi snapshot
neonxangi restore SNAPSHOT EMPTY_DESTINATION
neonxangi uninstall --yes [--keep-credentials]
```

Deletion, rebuild, policy application, and uninstall require `--yes`. Restore refuses a non-empty destination. Console cannot bind beyond loopback without an authenticated TLS proxy.

## Recovery

1. Run `neonxangi status` and `neonxangi logs`.
2. Run `neonxangi doctor` to separate gateway/version/config failures.
3. Create and verify a snapshot.
4. Use `sandbox rebuild --yes`; it archives xangi/Integration state without credentials, verifies the host snapshot manifest, replaces the sandbox, restores state, and only then starts the workload.
5. If containment is uncertain, stop the host plane and delete the sandbox. Revoke channel/provider credentials from their authoritative systems.
