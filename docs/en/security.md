# Security verification

> [!CAUTION]
> This is an experimental verification checklist, not a completed security assessment. Passing it does not demonstrate the absence of vulnerabilities or make a deployment production-safe. Each OpenShell driver, host, policy, credential path, and operational environment requires separate review and testing.

[日本語](../security.md)

Run these checks on every supported OpenShell driver before even considering it for use.

## Automated

```bash
npm ci
npm run check
neonxangi doctor
```

The tests cover capability tampering, expiry, binding, replay, path traversal, one-use approval, fail-closed audit behavior, snapshot exclusions and integrity, Integration identity checks, and the Bridge-to-xangi path. This coverage is limited to the implemented test cases and is not a vulnerability assessment.

## Sandbox smoke test

Inside the sandbox, verify all of the following:

- `DISCORD_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, and raw provider keys are absent.
- reading host home, SSH keys, Docker socket, and OpenShell management endpoints fails.
- writing outside the allowed workspace/state/tmp paths fails.
- writing inside the workspace also fails under `observe` and `research`.
- an allowlisted GitHub GET succeeds in `develop`; POST and git receive-pack fail.
- private-network and metadata endpoints fail.
- Codex web search, apps, browser, plugin, and MCP tools are unavailable.
- changing policy or deleting the sandbox from inside fails.
- a modified, expired, cross-workspace, cross-user, or replayed capability fails.

Codex OAuth is materialized only as an OpenShell-placeholder-backed `auth.json` inside the sandbox. The access, refresh, and account fields are opaque placeholders resolved by the OpenShell proxy; the locally parsed ID token is a non-secret synthetic JWT. Snapshot selection excludes the Codex auth directory, host signing key, live capability tokens, PID/lock/socket files, and quarantine data.

The OpenShell destination allowlist controls direct network traffic from commands inside the sandbox. Provider-hosted web search, apps, browser, plugins, and MCP use separate paths, so the Codex image disables them with admin-enforced `/etc/codex/requirements.toml`. The ordinary `config.toml` also sets `web_search = "disabled"`, but the system requirements are the boundary that project configuration cannot override. Hosted tools from other AI backends require separate verification.

From the host, confirm the permitted Discord round trip and correlate Bridge and Integration audit events. Then destroy the test sandbox and verify no process, mount, port forward, or capability remains.

Record the exact driver, OpenShell version, host kernel, policy, image digest, and test date. Re-run the assessment after any change to them. Independent review and adversarial testing remain necessary before handling production credentials or sensitive data.
