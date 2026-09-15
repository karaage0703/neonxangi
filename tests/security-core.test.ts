import {
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalStore } from "../src/approvals.js";
import { AuditLog } from "../src/audit.js";
import {
  authorize,
  CapabilityError,
  generateKeypair,
  issue,
  loadPrivateKey,
  loadPublicKey,
  ReplayGuard,
  verify,
  type IssueOptions,
} from "../src/capability.js";
import { Broker, safePath } from "../src/broker.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "neonxangi-test-"));
  temporary.push(path);
  return path;
}

function keys(
  root: string,
): [ReturnType<typeof loadPrivateKey>, ReturnType<typeof loadPublicKey>] {
  const [privatePath, publicPath] = generateKeypair(join(root, "keys"));
  return [loadPrivateKey(privatePath), loadPublicKey(publicPath)];
}

function options(overrides: Partial<IssueOptions> = {}): IssueOptions {
  return {
    audience: "broker",
    sandboxId: "sandbox",
    sessionId: "session",
    subject: { platform: "discord", user_id: "user", channel_id: "channel" },
    workspaceId: "workspace",
    grants: [
      { capability: "workspace", actions: ["read"], resources: ["README.md"] },
    ],
    ...overrides,
  };
}

describe("signed capabilities", () => {
  it("issues, verifies, authorizes, and rejects replay", () => {
    const root = directory();
    const [privateKey, publicKey] = keys(root);
    const claims = verify(issue(privateKey, options({ now: 100 })), publicKey, {
      expectedAudience: "broker",
      expectedSandbox: "sandbox",
      now: 101,
    });
    expect(authorize(claims, "workspace", "read", "README.md")).toBe(true);
    expect(authorize(claims, "workspace", "write", "README.md")).toBe(false);
    const guard = new ReplayGuard();
    guard.consume(claims, 101);
    expect(() => guard.consume(claims, 101)).toThrow("already used");
    expect(
      statSync(join(root, "keys", "capability-private.pem")).mode & 0o777,
    ).toBe(0o600);
  });

  it("rejects tampering, wrong audience, expiry, and unsafe TTL", () => {
    const [privateKey, publicKey] = keys(directory());
    const token = issue(privateKey, options({ now: 100 }));
    const [prefix, payload, signature] = token.split(".");
    const tampered = `${prefix}.${payload![0] === "A" ? "B" : "A"}${payload!.slice(1)}.${signature}`;
    expect(() =>
      verify(tampered, publicKey, {
        expectedAudience: "broker",
        expectedSandbox: "sandbox",
        now: 101,
      }),
    ).toThrow(CapabilityError);
    expect(() =>
      verify(token, publicKey, {
        expectedAudience: "integration",
        expectedSandbox: "sandbox",
        now: 101,
      }),
    ).toThrow("another service");
    expect(() =>
      verify(token, publicKey, {
        expectedAudience: "broker",
        expectedSandbox: "sandbox",
        now: 1000,
      }),
    ).toThrow("expired");
    expect(() => issue(privateKey, options({ ttlSeconds: 301 }))).toThrow(
      "TTL",
    );
  });

  it("refuses to overwrite identity and invalid keys", () => {
    const root = directory();
    generateKeypair(root);
    expect(() => generateKeypair(root)).toThrow("overwrite");
    writeFileSync(join(root, "bad.pem"), "bad");
    expect(() => loadPublicKey(join(root, "bad.pem"))).toThrow("not Ed25519");
  });
});

describe("approval and broker boundary", () => {
  it("persists one-shot approvals", () => {
    const root = directory();
    const store = new ApprovalStore(join(root, "approvals.json"));
    const approval = store.create({
      correlation_id: "c",
      subject: "s",
      capability: "workspace",
      action: "write",
      resource: "x",
      summary: "write x",
    });
    expect(store.list("pending")).toHaveLength(1);
    store.decide(approval.id, "approved");
    store.consumeApproved(approval.id, {
      capability: "workspace",
      action: "write",
      resource: "x",
    });
    expect(store.get(approval.id).status).toBe("consumed");
    expect(() =>
      store.consumeApproved(approval.id, {
        capability: "workspace",
        action: "write",
        resource: "x",
      }),
    ).toThrow("not approved");
    expect(
      new ApprovalStore(join(root, "approvals.json")).get(approval.id).status,
    ).toBe("consumed");
    expect(statSync(join(root, "approvals.json")).mode & 0o777).toBe(0o600);
  });

  it("reads and searches only inside the workspace", () => {
    const root = directory();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "README.md"), "hello needle\n");
    writeFileSync(join(root, "secret"), "hidden");
    symlinkSync(join(root, "secret"), join(workspace, "escape"));
    expect(() => safePath(workspace, "../secret")).toThrow("escapes");
    expect(() => safePath(workspace, "escape")).toThrow("escapes");
    const [privateKey, publicKey] = keys(root);
    const broker = new Broker({
      workspaceId: "workspace",
      workspace,
      sandboxId: "sandbox",
      publicKey,
      audit: new AuditLog(join(root, "audit.jsonl")),
      approvals: new ApprovalStore(join(root, "approvals.json")),
    });
    const readToken = issue(privateKey, options());
    const [readStatus, readResult] = broker.execute(readToken, {
      capability: "workspace",
      action: "read",
      resource: "README.md",
    });
    expect(readStatus).toBe(200);
    expect(readResult.result).toMatchObject({ content: "hello needle\n" });
    const searchToken = issue(
      privateKey,
      options({
        grants: [
          { capability: "workspace", actions: ["search"], resources: ["."] },
        ],
      }),
    );
    const [searchStatus, searchResult] = broker.execute(searchToken, {
      capability: "workspace",
      action: "search",
      resource: ".",
      input: { query: "needle" },
    });
    expect(searchStatus).toBe(200);
    expect(searchResult.result).toMatchObject({
      matches: [{ path: "README.md", line: 1, text: "hello needle" }],
    });
    expect(
      broker.execute(searchToken, {
        capability: "workspace",
        action: "search",
        resource: ".",
        input: { query: "needle" },
      })[0],
    ).toBe(403);
  });

  it("creates an approval request for mutations and audits it", () => {
    const root = directory();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const [privateKey, publicKey] = keys(root);
    const audit = new AuditLog(join(root, "audit.jsonl"));
    const broker = new Broker({
      workspaceId: "workspace",
      workspace,
      sandboxId: "sandbox",
      publicKey,
      audit,
      approvals: new ApprovalStore(join(root, "approvals.json")),
    });
    const token = issue(
      privateKey,
      options({
        grants: [
          {
            capability: "workspace",
            actions: ["write"],
            resources: ["new.txt"],
          },
        ],
      }),
    );
    const [status, result] = broker.execute(token, {
      capability: "workspace",
      action: "write",
      resource: "new.txt",
    });
    expect(status).toBe(202);
    expect(result.approval_required).toBe(true);
    expect(audit.tail().map((event) => event.outcome)).toContain("pending");
    expect(readFileSync(join(root, "audit.jsonl"), "utf8")).not.toContain(
      "hidden-token",
    );
  });
});
