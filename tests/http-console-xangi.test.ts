import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalStore } from "../src/approvals.js";
import { AuditLog } from "../src/audit.js";
import { Console, serveConsole } from "../src/console.js";
import { parseSse, safeEqual } from "../src/http.js";
import { XangiClient, XangiError } from "../src/xangi.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "neonxangi-test-"));
  roots.push(value);
  return value;
}
async function url(server: Server): Promise<string> {
  if (!server.listening)
    await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}`;
}

describe("HTTP and Console", () => {
  it("explains setup and hides unauthenticated navigation", () => {
    const html = readFileSync(join(process.cwd(), "web", "index.html"), "utf8");
    expect(html).toContain("Neon Xangi セットアップ");
    expect(html).toContain("この画面で行うこと");
    expect(html).toContain('id="console-nav"');
    expect(html).toContain(
      'id="console-nav" aria-label="設定画面内の移動" hidden',
    );
    expect(html).not.toContain("設定し、境界を確かめる。");
    expect(html).toContain("Bot token（xoxb-…）");
    expect(html).toContain("dotenvや絶対pathの準備は不要です");
    expect(html).not.toContain("Credential dotenvの絶対path");
    expect(html).toContain("できること・できないこと");
    expect(html).toContain("backendのWeb機能");
    const javascript = readFileSync(
      join(process.cwd(), "web", "app.js"),
      "utf8",
    );
    expect(javascript).not.toContain("sessionStorage");
    expect(javascript).toContain("OpenShell active policy");
  });

  it("parses SSE and compares tokens safely", async () => {
    const response = new Response(
      'event: progress\ndata: {"message":"one"}\n\nevent: done\ndata: {"response":"two"}\n\n',
    );
    const events = [];
    for await (const event of parseSse(response)) events.push(event);
    expect(events).toEqual([
      { event: "progress", message: "one" },
      { event: "done", response: "two" },
    ]);
    expect(safeEqual("token", "token")).toBe(true);
    expect(safeEqual("token", "other")).toBe(false);
  });

  it("serves static assets and protects admin APIs", async () => {
    const dir = root();
    const web = join(dir, "web");
    mkdirSync(web);
    writeFileSync(join(web, "index.html"), "<h1>Neo</h1>");
    const approvals = new ApprovalStore(join(dir, "approvals.json"));
    const approval = approvals.create({
      correlation_id: "c",
      subject: "s",
      capability: "workspace",
      action: "write",
      resource: "x",
      summary: "x",
    });
    const consoleApp = new Console({
      token: "secret",
      audit: new AuditLog(join(dir, "audit.jsonl")),
      approvals,
      status: () => ({ healthy: true }),
      policy: () => ({ profile: "develop" }),
      config: () => ({ runtime: {} }),
      validateConfig: () => ({ valid: true }),
      saveConfig: () => ({ saved: true, restart_required: true }),
      doctor: () => [{ name: "ok", status: "pass", detail: "ok" }],
      webRoot: web,
    });
    expect(() => serveConsole(consoleApp, "0.0.0.0", 0)).toThrow("loopback");
    const server = serveConsole(consoleApp, "127.0.0.1", 0);
    servers.push(server);
    const base = await url(server);
    expect(await (await fetch(base)).text()).toContain("Neo");
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    const headers = { Authorization: "Bearer secret" };
    expect(
      await (await fetch(`${base}/api/status`, { headers })).json(),
    ).toEqual({ healthy: true });
    const bootstrap = (await (
      await fetch(`${base}/api/session/bootstrap`, {
        method: "POST",
        headers,
      })
    ).json()) as { path: string };
    const exchange = await fetch(`${base}${bootstrap.path}`, {
      redirect: "manual",
    });
    expect(exchange.status).toBe(303);
    const sessionCookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    expect(sessionCookie).toMatch(/^neonxangi_session=/u);
    expect(
      await (
        await fetch(`${base}/api/status`, {
          headers: { Cookie: sessionCookie ?? "" },
        })
      ).json(),
    ).toEqual({ healthy: true });
    expect(
      await fetch(`${base}${bootstrap.path}`, { redirect: "manual" }),
    ).toHaveProperty("status", 404);
    expect(
      (
        await fetch(`${base}/api/approvals/${approval.id}/approve`, {
          method: "POST",
          headers: { ...headers, "Content-Length": "0" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/api/config`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
  });
});

describe("xangi client", () => {
  it("uses session, chat, and remote platform endpoints", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/sessions") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"sessionId":"s1"}');
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        request.url === "/api/chat"
          ? 'event: done\ndata: {"response":"chat"}\n\n'
          : 'event: started\ndata: {}\n\nevent: done\ndata: {"response":"remote"}\n\n',
      );
    }).listen(0, "127.0.0.1");
    servers.push(server);
    const base = await url(server);
    const client = new XangiClient(base, 1000, "remote-token");
    expect(await client.createSession()).toBe("s1");
    expect(await client.turn("s1", "hello")).toBe("chat");
    const events = [];
    for await (const event of client.remoteTurn({ text: "hello" }))
      events.push(event.event);
    expect(events).toEqual(["started", "done"]);
  });

  it("rejects non-loopback and missing remote credentials", async () => {
    expect(() => new XangiClient("https://example.com")).toThrow(XangiError);
    const client = new XangiClient("http://127.0.0.1:1", 10, "");
    await expect(async () => {
      for await (const _event of client.remoteTurn({})) void _event;
    }).rejects.toThrow("not configured");
  });
});
