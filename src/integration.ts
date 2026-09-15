import { createHash, type KeyObject } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AuditLog } from "./audit.js";
import { AuditLog as AuditLogValue } from "./audit.js";
import {
  authorize,
  CapabilityError,
  ReplayGuard,
  verify,
} from "./capability.js";
import { loadPublicKey } from "./capability.js";
import { bearerToken, readJson, sendJson, type SseEvent } from "./http.js";
import { XangiClient, XangiError } from "./xangi.js";

const MIB = 1024 * 1024;

export interface XangiLike {
  createSession(): Promise<string>;
  turn(sessionId: string, message: string): Promise<string>;
  remoteTurn?(body: Record<string, unknown>): AsyncGenerator<SseEvent>;
}

export class SessionMap {
  private sessions: Record<string, string>;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sessions = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>)
      : {};
  }

  async getOrCreate(conversation: string, client: XangiLike): Promise<string> {
    if (this.sessions[conversation]) return this.sessions[conversation];
    const sessionId = await client.createSession();
    this.sessions[conversation] = sessionId;
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(this.sessions, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, this.path);
    return sessionId;
  }
}

interface Materialized {
  directory?: string;
  paths: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strictBase64(value: string): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new Error("attachment content is not valid base64");
  }
  return Buffer.from(value, "base64");
}

function inside(path: string, root: string): boolean {
  const value = relative(root, path);
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  );
}

export class Integration {
  readonly sessions: SessionMap;
  readonly audit: AuditLog;
  private readonly replayGuard = new ReplayGuard();

  constructor(
    readonly input: {
      sandboxId: string;
      workspaceId: string;
      publicKey: KeyObject;
      xangi: XangiLike;
      stateDir: string;
      audit?: AuditLog;
    },
  ) {
    this.sessions = new SessionMap(
      join(input.stateDir, "integration-sessions.json"),
    );
    this.audit =
      input.audit ??
      new AuditLogValue(join(input.stateDir, "integration-audit.jsonl"));
  }

  private materializeAttachments(
    raw: unknown,
    correlationId: string,
  ): Materialized {
    if (!raw) return { paths: [] };
    if (!Array.isArray(raw) || raw.length > 10) {
      throw new Error("attachments must be a list with at most 10 entries");
    }
    const destination = join(this.input.stateDir, "attachments", correlationId);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    mkdirSync(destination, { recursive: false, mode: 0o700 });
    const paths: string[] = [];
    let total = 0;
    try {
      for (const [index, rawItem] of raw.entries()) {
        const item = record(rawItem);
        if (!item) throw new Error("attachment entry must be an object");
        const name = basename(String(item.name ?? ""));
        if (!name || [".", ".."].includes(name))
          throw new Error("attachment name is invalid");
        const content = strictBase64(String(item.content_b64 ?? ""));
        if (content.length > 25 * MIB)
          throw new Error("attachment exceeds 25 MiB");
        total += content.length;
        if (total > 50 * MIB)
          throw new Error("attachments exceed the 50 MiB turn limit");
        const expected = String(item.sha256 ?? "");
        if (
          expected &&
          createHash("sha256").update(content).digest("hex") !== expected
        ) {
          throw new Error("attachment digest mismatch");
        }
        const target = join(
          destination,
          `${String(index).padStart(2, "0")}-${name}`,
        );
        writeFileSync(target, content, { mode: 0o600 });
        chmodSync(target, 0o600);
        paths.push(target);
      }
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
    return { directory: destination, paths };
  }

  private authorize(
    token: string,
    body: Record<string, unknown>,
  ): [ReturnType<typeof verify>, string] {
    const claims = verify(token, this.input.publicKey, {
      expectedAudience: "integration",
      expectedSandbox: this.input.sandboxId,
    });
    if (claims.workspace_id !== this.input.workspaceId) {
      throw new CapabilityError("capability is bound to another workspace");
    }
    if (!authorize(claims, "xangi", "turn", this.input.workspaceId)) {
      throw new CapabilityError("xangi turn is not authorized");
    }
    const actual = {
      platform: String(body.platform ?? ""),
      user_id: String(body.user_id ?? ""),
      channel_id: String(body.channel_id ?? ""),
    };
    if (JSON.stringify(actual) !== JSON.stringify(claims.subject)) {
      throw new CapabilityError(
        "request identity does not match the capability subject",
      );
    }
    const message = String(body.message ?? "").trim();
    if (!message || message.length > 100_000) {
      throw new Error("message must be between 1 and 100000 characters");
    }
    this.replayGuard.consume(claims);
    return [claims, message];
  }

  static encodeOutboundAttachments(
    raw: unknown,
  ): Array<Record<string, unknown>> {
    if (!Array.isArray(raw)) return [];
    const allowedRoots = ["/workspace", "/var/lib/xangi"]
      .filter(existsSync)
      .map((path) => realpathSync(path));
    const encoded: Array<Record<string, unknown>> = [];
    let total = 0;
    for (const value of raw.slice(0, 10)) {
      const path = resolve(String(value));
      if (!existsSync(path)) continue;
      const actual = realpathSync(path);
      if (
        !allowedRoots.some((root) => inside(actual, root)) ||
        !statSync(actual).isFile()
      )
        continue;
      const content = readFileSync(actual);
      if (content.length > 25 * MIB) continue;
      total += content.length;
      if (total > 50 * MIB) break;
      encoded.push({
        name: basename(actual),
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        content_b64: content.toString("base64"),
      });
    }
    return encoded;
  }

  async *turnEvents(
    token: string,
    body: Record<string, unknown>,
  ): AsyncGenerator<SseEvent> {
    const [claims, message] = this.authorize(token, body);
    const correlationId = String(body.correlation_id ?? "") || undefined;
    const started = this.audit.write({
      component: "integration",
      action: "xangi.turn",
      outcome: "started",
      subject: { ...claims.subject },
      resource: this.input.workspaceId,
      ...(correlationId ? { correlationId } : {}),
    });
    const materialized = this.materializeAttachments(
      body.attachments,
      `turn-${randomUUID().replaceAll("-", "")}`,
    );
    const remoteBody: Record<string, unknown> = {
      platform: claims.subject.platform,
      contextKey: String(body.conversation_id ?? claims.xangi_session_id),
      settingsChannelId: String(
        body.settings_channel_id ?? claims.subject.channel_id,
      ),
      channelId: claims.subject.channel_id,
      messageId: String(
        body.message_id ?? body.event_id ?? correlationId ?? "",
      ),
      userId: claims.subject.user_id,
      userName: String(body.user_name ?? claims.subject.user_id),
      text: message,
    };
    for (const [target, source] of [
      ["channelName", "channel_name"],
      ["threadId", "thread_id"],
      ["threadName", "thread_name"],
      ["parentChannelName", "parent_channel_name"],
    ] as const) {
      if (body[source]) remoteBody[target] = body[source];
    }
    if (materialized.paths.length > 0)
      remoteBody.attachments = materialized.paths;
    let finished = false;
    const finish = (outcome: string, reason = ""): void => {
      if (finished) return;
      this.audit.write({
        component: "integration",
        action: "xangi.turn",
        outcome,
        subject: { ...claims.subject },
        resource: this.input.workspaceId,
        correlationId: started.correlation_id,
        ...(reason ? { details: { reason } } : {}),
      });
      if (materialized.directory)
        rmSync(materialized.directory, { recursive: true, force: true });
      finished = true;
    };
    try {
      if (this.input.xangi.remoteTurn) {
        for await (const original of this.input.xangi.remoteTurn(remoteBody)) {
          const event = { ...original };
          if (event.event === "done") {
            event.attachments = Integration.encodeOutboundAttachments(
              event.attachments,
            );
          }
          if (event.event === "done" || event.event === "error") {
            finish(
              event.event === "done" ? "completed" : "failed",
              String(event.message ?? ""),
            );
          }
          yield event;
        }
      } else {
        const conversation = `${claims.subject.platform}:${claims.subject.channel_id}:${claims.xangi_session_id}`;
        const sessionId = await this.sessions.getOrCreate(
          conversation,
          this.input.xangi,
        );
        yield { event: "started", appSessionId: sessionId };
        const response = await this.input.xangi.turn(sessionId, message);
        finish("completed");
        yield { event: "done", response, appSessionId: sessionId };
      }
      finish("completed");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      finish("failed", reason);
      yield { event: "error", message: reason };
    } finally {
      if (materialized.directory)
        rmSync(materialized.directory, { recursive: true, force: true });
    }
  }

  async turn(
    token: string,
    body: Record<string, unknown>,
  ): Promise<[number, Record<string, unknown>]> {
    try {
      const events: SseEvent[] = [];
      for await (const event of this.turnEvents(token, body))
        events.push(event);
      const done = events.findLast((event) => event.event === "done");
      if (!done) {
        const failed = events.findLast((event) => event.event === "error");
        throw new XangiError(
          String(failed?.message ?? "xangi stream ended without completion"),
        );
      }
      return [200, { ok: true, ...done }];
    } catch (error) {
      return [
        error instanceof CapabilityError ? 403 : 502,
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  }
}

export function serveIntegration(
  integration: Integration,
  host: string,
  port: number,
): Server {
  return createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/healthz") {
        sendJson(response, 200, { ok: true, component: "integration" });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/turn") {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      let events: AsyncGenerator<SseEvent>;
      try {
        events = integration.turnEvents(
          bearerToken(request),
          await readJson(request, 72 * MIB),
        );
        const first = await events.next();
        if (first.done) throw new Error("integration produced no events");
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          Connection: "close",
        });
        const send = (event: SseEvent): void => {
          const { event: eventName, ...payload } = event;
          response.write(
            `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`,
          );
        };
        send(first.value);
        for await (const event of events) send(event);
        response.end();
      } catch (error) {
        if (!response.headersSent) {
          sendJson(response, error instanceof CapabilityError ? 403 : 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          response.destroy(error instanceof Error ? error : undefined);
        }
      }
    })();
  }).listen(port, host);
}

export function createIntegrationFromPaths(input: {
  sandboxId: string;
  workspaceId: string;
  publicKeyPath: string;
  xangiUrl: string;
  stateDir: string;
}): Integration {
  return new Integration({
    sandboxId: input.sandboxId,
    workspaceId: input.workspaceId,
    publicKey: loadPublicKey(input.publicKeyPath),
    xangi: new XangiClient(input.xangiUrl),
    stateDir: input.stateDir,
  });
}
