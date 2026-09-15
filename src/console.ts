import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { ApprovalStore } from "./approvals.js";
import { ApprovalError } from "./approvals.js";
import type { AuditLog } from "./audit.js";
import { readJson, safeEqual, sendJson } from "./http.js";

type Value = Record<string, unknown>;
type MaybePromise<T> = T | Promise<T>;

export interface ConsoleOptions {
  token: string;
  audit: AuditLog;
  approvals: ApprovalStore;
  status: () => MaybePromise<Value>;
  policy: () => MaybePromise<Value>;
  config?: () => MaybePromise<Value>;
  validateConfig?: (value: Value) => MaybePromise<Value>;
  saveConfig?: (value: Value) => MaybePromise<Value>;
  doctor?: () => MaybePromise<
    Array<{ name: string; status: string; detail: string }>
  >;
  webRoot: string;
}

export class Console {
  private readonly browserTickets = new Map<string, number>();
  private readonly browserSessions = new Map<string, number>();

  constructor(readonly options: ConsoleOptions) {}

  authorized(supplied: string, browserSession = ""): boolean {
    if (Boolean(supplied) && safeEqual(supplied, this.options.token))
      return true;
    const expiresAt = this.browserSessions.get(browserSession) ?? 0;
    if (expiresAt <= Date.now()) {
      if (browserSession) this.browserSessions.delete(browserSession);
      return false;
    }
    return true;
  }

  createBrowserSession(): string {
    const now = Date.now();
    for (const [ticket, expiresAt] of this.browserTickets)
      if (expiresAt <= now) this.browserTickets.delete(ticket);
    for (const [session, expiresAt] of this.browserSessions)
      if (expiresAt <= now) this.browserSessions.delete(session);
    const ticket = randomBytes(24).toString("base64url");
    this.browserTickets.set(ticket, now + 60_000);
    return `/session/${ticket}`;
  }

  exchangeBrowserTicket(ticket: string): string | undefined {
    const expiresAt = this.browserTickets.get(ticket) ?? 0;
    this.browserTickets.delete(ticket);
    if (expiresAt <= Date.now()) return undefined;
    const session = randomBytes(32).toString("base64url");
    this.browserSessions.set(session, Date.now() + 8 * 60 * 60 * 1000);
    return session;
  }
}

function cookie(header: string | undefined, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function staticResponse(path: string): { content: Buffer; type: string } {
  const content = readFileSync(path);
  const extension = extname(path);
  const type =
    extension === ".html"
      ? "text/html; charset=utf-8"
      : extension === ".css"
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8";
  return { content, type };
}

export function serveConsole(
  console: Console,
  host: string,
  port: number,
): Server {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error(
      "Console may only bind to loopback without an authenticated TLS proxy",
    );
  }
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true, component: "console" });
        return;
      }
      const browserSessionMatch = /^\/session\/([A-Za-z0-9_-]+)$/u.exec(
        url.pathname,
      );
      if (request.method === "GET" && browserSessionMatch?.[1]) {
        const session = console.exchangeBrowserTicket(browserSessionMatch[1]);
        if (!session) {
          sendJson(response, 404, { error: "browser session expired" });
          return;
        }
        response.writeHead(303, {
          Location: "/",
          "Cache-Control": "no-store",
          "Set-Cookie": `neonxangi_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        });
        response.end();
        return;
      }
      if (
        request.method === "GET" &&
        ["/", "/app.css", "/app.js"].includes(url.pathname)
      ) {
        const name =
          url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        try {
          const asset = staticResponse(join(console.options.webRoot, name));
          response.writeHead(200, {
            "Content-Type": asset.type,
            "Content-Length": String(asset.content.length),
            "Cache-Control": "no-store",
            "Content-Security-Policy":
              "default-src 'self'; style-src 'self'; script-src 'self'",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
          });
          response.end(asset.content);
        } catch {
          sendJson(response, 404, { error: "not found" });
        }
        return;
      }
      const supplied = (request.headers.authorization ?? "").replace(
        /^Bearer /u,
        "",
      );
      if (
        !console.authorized(
          supplied,
          cookie(request.headers.cookie, "neonxangi_session"),
        )
      ) {
        sendJson(response, 401, { error: "admin token required" });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/session/bootstrap"
      ) {
        sendJson(response, 200, { path: console.createBrowserSession() });
        return;
      }
      if (request.method === "GET") {
        if (url.pathname === "/api/status")
          sendJson(response, 200, await console.options.status());
        else if (url.pathname === "/api/policy")
          sendJson(response, 200, await console.options.policy());
        else if (url.pathname === "/api/audit")
          sendJson(response, 200, { events: console.options.audit.tail(200) });
        else if (url.pathname === "/api/approvals")
          sendJson(response, 200, {
            approvals: console.options.approvals.list(),
          });
        else if (url.pathname === "/api/config" && console.options.config)
          sendJson(response, 200, await console.options.config());
        else sendJson(response, 404, { error: "not found" });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      try {
        if (
          url.pathname === "/api/config/validate" &&
          console.options.validateConfig
        ) {
          sendJson(
            response,
            200,
            await console.options.validateConfig(await readJson(request)),
          );
          return;
        }
        if (url.pathname === "/api/config" && console.options.saveConfig) {
          const result = await console.options.saveConfig(
            await readJson(request),
          );
          console.options.audit.write({
            component: "console",
            action: "config.save",
            outcome: "completed",
            details: { restart_required: Boolean(result.restart_required) },
          });
          sendJson(response, 200, result);
          return;
        }
        if (url.pathname === "/api/doctor" && console.options.doctor) {
          const checks = await console.options.doctor();
          sendJson(response, 200, {
            ok: checks.every((item) => item.status === "pass"),
            checks,
          });
          return;
        }
        const match = /^\/api\/approvals\/([^/]+)\/(approve|deny)$/u.exec(
          url.pathname,
        );
        if (!match?.[1] || !match[2]) {
          sendJson(response, 404, { error: "not found" });
          return;
        }
        const decision = match[2] === "approve" ? "approved" : "denied";
        const approval = console.options.approvals.decide(match[1], decision);
        console.options.audit.write({
          component: "console",
          action: "approval.decide",
          outcome: decision,
          resource: approval.resource,
          correlationId: approval.correlation_id,
          details: { approval_id: approval.id },
        });
        sendJson(response, 200, approval);
      } catch (error) {
        if (url.pathname === "/api/config") {
          console.options.audit.write({
            component: "console",
            action: "config.save",
            outcome: "failed",
            details: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        sendJson(response, error instanceof ApprovalError ? 409 : 422, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })().catch((error: unknown) => {
      if (!response.headersSent)
        sendJson(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  }).listen(port, host);
}
