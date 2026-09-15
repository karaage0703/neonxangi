# Architecture

> [!CAUTION]
> Neon Xangi is experimental. This design describes intended boundaries, not independently verified security guarantees.

[日本語](../design.md)

## Security position

Neon Xangi treats xangi, AI CLI processes, model output, skills, extensions, downloaded code, and workspace content as one untrusted Agent Workload. OpenShell supplies the OS and network boundary. Neon Xangi supplies channel, identity, capability, approval, and audit boundaries that network filtering alone cannot express.

```text
Discord ─┐                                               │
         ├─ host Platform Gateway ─ signed turn/SSE ─────┤
Slack ───┘                                               │
Admin ── loopback Console ── Controller ── OpenShell ─────┼─ sandbox
                              │                          │  ├─ Integration
                              ├─ capability signer       │  ├─ xangi
                              ├─ audit log               │  ├─ selected AI CLI
                              └─ Tool Broker ◀───────────┘  └─ workspace
```

Raw channel credentials, the Ed25519 private key, policy mutation, approval decisions, snapshot management, and sandbox destruction stay on the host. The sandbox receives the public verification key, an uploaded workspace, and provider access composed by OpenShell.

xangi is not prerequisite host software. It is the Agent runtime installed inside the sandbox image by the version-pinned Blueprint. On the workload's first start, xangi's typed setup CLI or setup store persists its Agent backend and `/workspace` configuration in xangi-owned state. Neon Xangi does not reimplement xangi's configuration format.

## Setup and configuration management

The managed bundle contains Node.js and a compatibility-pinned OpenShell CLI, and the launcher selects the bundled binary by default. This makes `neonxangi setup` the first product command after installation and hides runtime paths and checksums from users. Initial setup follows the same separation as xangi's guided onboarding. Deterministic host-side preflight selects an AI CLI from a fixed allowlist and starts a Japanese conversation through a mode-0600 temporary instruction file. The AI explicitly asks which sandboxed xangi backend to use from Codex, Claude Code, xangi Local LLM, and GitHub Copilot CLI, then recommends a fresh clone of `ai-assistant-workspace`, while also offering an empty workspace or an existing workspace explicitly named by the user. The typed `setup --apply` path validates and persists the selection. Because this AI CLI runs with host-user authority before OpenShell exists, it never asks for secret values; platform credential setup is deferred to the Console.

The Console configuration API limits editable fields to a fixed runtime, Discord, and Slack schema. It rejects unknown fields, wildcards, auto-reply channels outside the allowlist, unavailable workspaces, and invalid sandbox names. Submitted tokens are atomically written to dedicated mode-0600 secret files. GET responses expose neither raw secrets nor internal paths, only validation status. Saves are not hot-applied to a running Gateway and explicitly report that a restart is required. Standalone `settings` mode and the running host share the same API/UI. A browser opened by the CLI exchanges a 60-second one-use ticket for an eight-hour HttpOnly/SameSite cookie, without putting the persistent management token in a URL or browser storage. The manually opened root URL alone shows an explained recovery-token field.

## Capability contract

Capabilities are Ed25519-signed `nx1` tokens. Claims bind issuer, sandbox, xangi conversation, platform user, channel, workspace, allowed capability/action/resource tuples, expiry, and a nonce. Maximum lifetime is five minutes; normal turns use two minutes. Integration and Broker reject signature changes, expired tokens, subject/resource mismatches, and nonce replay.

Capability authorization never substitutes for OpenShell enforcement. Filesystem and network policy must reject the same forbidden path even if application code is compromised.

## Turn path

1. The host Gateway validates Discord or Slack user/channel allowlists and deduplicates the event ID.
2. The Controller signs a one-turn capability bound to that event’s subject and workspace.
3. The Bridge forwards normalized content to the sandbox Integration through a loopback OpenShell gRPC service forward owned and supervised by the host Controller.
4. Integration verifies the signature, identity, scope, expiry, and nonce, then normalizes an authenticated Remote Platform event.
5. xangi retains the platform type while using its normal session, workspace binding, Agent, and shared lifecycle-event core. It runs the selected AI backend through the OpenShell-managed provider route or the Local LLM loopback relay. The relay target is fixed at setup and permits only four inference/model-listing API paths. Platform tokens are absent from its environment.
6. Integration streams started, text, tool, error, and completion events. Only the host Gateway can add/remove reactions or post/edit Discord and Slack messages.
7. Host and sandbox audit records share a correlation ID.

## Side effects and approvals

Read actions may execute when named in a capability. A non-read Broker action creates a pending approval instead of executing. Approval records bind the exact capability, action, and resource and can be consumed once. A separate fresh capability is required for the post-approval attempt.

## Lifecycle

`doctor` checks the host, OpenShell version/gateway, workspace, profile, backend, and host identity. `sandbox create` builds the pinned blueprint, attaches the selected backend provider, admits only the workspace and public key, and starts xangi plus Integration. Under `observe` and `research`, the workspace is included at image build time so the sandbox never receives workspace write access. `start` launches the managed Integration forward, Bridge, Broker, and Console as a detached host process with PID and log files. Policy changes require a prior diff and explicit `--yes`. Rebuild snapshots credential-free host, xangi, and Integration state before replacement and restores it before workload startup.

## Versioning

`blueprint/manifest.yaml` is the compatibility source of truth. The image pins xangi v0.56.4 commit `726ecfc7f1e6d9bf7d553c203cff0a7b0a43b84e`, which includes the OpenShell runtime-environment integration and Remote Platform Adapter. No downstream patch is applied. OpenShell `>=0.0.116,<0.1.0` is accepted; arbitrary latest versions are not fetched at runtime.
