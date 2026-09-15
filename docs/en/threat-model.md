# Threat model

> [!CAUTION]
> This experimental threat model is incomplete and has not received an independent security review. “Required invariants” are design requirements to test and review, not proven guarantees.

[日本語](../threat-model.md)

## Protected assets

- Discord, Slack, and provider credentials
- capability signing key
- files outside the admitted workspace
- OpenShell and container-runtime control sockets
- policy, snapshot, restore, and destroy authority
- external side effects such as messages, repository writes, purchases, and production changes
- audit integrity and subject attribution

## Adversaries

- malicious prompt or attachment
- compromised skill, extension, dependency, or AI CLI
- model-generated command that exceeds user intent
- another local process attempting to call forwarded endpoints
- replayed or modified capability
- compromised sandboxed xangi process

## Required invariants

- No raw platform or provider credential is present in the Agent Workload.
- The workload cannot mutate its own OpenShell policy or manage the sandbox.
- Filesystem traversal, symlink escape, private-network access, and unlisted network destinations are denied.
- Capability use is bound to sandbox, session, user, channel, workspace, resource, action, expiry, and nonce.
- Every external side effect needs a narrowly scoped capability and, where required, a one-use host approval.
- Dangerous operations fail closed if authorization or audit persistence fails.
- Snapshots exclude credentials, signing keys, live capabilities, sockets, locks, and PID files.

## Out of scope

- Vulnerabilities in the host kernel, OpenShell driver, firmware, or hardware
- a malicious host administrator
- denial of service within configured CPU, memory, disk, and time limits
- claims that the system is completely safe
- multi-tenant isolation; the initial release is a single-operator reference stack
- independent penetration testing, formal verification, supply-chain audit, and exhaustive vulnerability assessment
