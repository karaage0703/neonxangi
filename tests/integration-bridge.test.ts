import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import {
  BridgeDispatcher,
  decodeOutboundAttachments,
  EventDeduplicator,
} from "../src/bridge.js";
import {
  generateKeypair,
  issue,
  loadPrivateKey,
  loadPublicKey,
} from "../src/capability.js";
import {
  Integration,
  serveIntegration,
  SessionMap,
  type XangiLike,
} from "../src/integration.js";
import type { SseEvent } from "../src/http.js";

const roots: string[] = [];
const servers: Array<ReturnType<typeof serveIntegration>> = [];
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

class FakeXangi implements XangiLike {
  created = 0;
  async createSession(): Promise<string> {
    this.created += 1;
    return `session-${this.created}`;
  }
  async turn(sessionId: string, message: string): Promise<string> {
    return `${sessionId}:${message}`;
  }
}

describe("integration boundary", () => {
  it("binds identity, rejects replay, and persists fallback sessions", async () => {
    const dir = root();
    const [privatePath, publicPath] = generateKeypair(join(dir, "keys"));
    const privateKey = loadPrivateKey(privatePath);
    const xangi = new FakeXangi();
    const integration = new Integration({
      sandboxId: "sandbox",
      workspaceId: "workspace",
      publicKey: loadPublicKey(publicPath),
      xangi,
      stateDir: dir,
    });
    const token = issue(privateKey, {
      audience: "integration",
      sandboxId: "sandbox",
      sessionId: "conversation",
      subject: { platform: "discord", user_id: "user", channel_id: "channel" },
      workspaceId: "workspace",
      grants: [
        { capability: "xangi", actions: ["turn"], resources: ["workspace"] },
      ],
    });
    const body = {
      platform: "discord",
      user_id: "user",
      channel_id: "channel",
      conversation_id: "conversation",
      message: "hello",
    };
    const [status, value] = await integration.turn(token, body);
    expect(status).toBe(200);
    expect(value.response).toBe("session-1:hello");
    expect((await integration.turn(token, body))[0]).toBe(403);
    const wrongToken = issue(privateKey, {
      audience: "integration",
      sandboxId: "sandbox",
      sessionId: "conversation",
      subject: { platform: "discord", user_id: "other", channel_id: "channel" },
      workspaceId: "workspace",
      grants: [
        { capability: "xangi", actions: ["turn"], resources: ["workspace"] },
      ],
    });
    expect((await integration.turn(wrongToken, body))[0]).toBe(403);
    expect(xangi.created).toBe(1);
    expect(
      await new SessionMap(join(dir, "integration-sessions.json")).getOrCreate(
        "discord:channel:conversation",
        xangi,
      ),
    ).toBe("session-1");
  });

  it("streams through the HTTP gateway and dispatcher", async () => {
    const dir = root();
    const [privatePath, publicPath] = generateKeypair(join(dir, "keys"));
    const remote: XangiLike = {
      async createSession() {
        return "unused";
      },
      async turn() {
        return "unused";
      },
      async *remoteTurn(): AsyncGenerator<SseEvent> {
        yield { event: "started", appSessionId: "remote" };
        yield { event: "progress", message: "working" };
        yield { event: "done", response: "finished" };
      },
    };
    const server = serveIntegration(
      new Integration({
        sandboxId: "sandbox",
        workspaceId: "workspace",
        publicKey: loadPublicKey(publicPath),
        xangi: remote,
        stateDir: dir,
      }),
      "127.0.0.1",
      0,
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const dispatcher = new BridgeDispatcher({
      integrationUrl: `http://127.0.0.1:${address.port}`,
      privateKey: loadPrivateKey(privatePath),
      sandboxId: "sandbox",
      workspaceId: "workspace",
      audit: new AuditLog(join(dir, "host-audit.jsonl")),
    });
    const seen: string[] = [];
    const reply = await dispatcher.dispatch(
      {
        event_id: "event",
        platform: "discord",
        user_id: "user",
        channel_id: "channel",
        conversation_id: "conversation",
        message: "hello",
      },
      (event) => {
        seen.push(event.event);
      },
    );
    expect(reply).toBe("finished");
    expect(seen).toEqual(["started", "progress", "done"]);
    expect(
      await dispatcher.dispatch({
        event_id: "event",
        platform: "discord",
        user_id: "user",
        channel_id: "channel",
        conversation_id: "conversation",
        message: "hello",
      }),
    ).toBeUndefined();
  });

  it("serializes turns for the same conversation", async () => {
    const dir = root();
    const [privatePath, publicPath] = generateKeypair(join(dir, "keys"));
    let releaseFirst = (): void => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted = (): void => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const messages: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const remote: XangiLike = {
      async createSession() {
        return "unused";
      },
      async turn() {
        return "unused";
      },
      async *remoteTurn(body): AsyncGenerator<SseEvent> {
        const message = String(body.text);
        messages.push(message);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (message === "first") {
            markFirstStarted();
            await firstBlocked;
          }
          yield { event: "done", response: message };
        } finally {
          active -= 1;
        }
      },
    };
    const server = serveIntegration(
      new Integration({
        sandboxId: "sandbox",
        workspaceId: "workspace",
        publicKey: loadPublicKey(publicPath),
        xangi: remote,
        stateDir: dir,
      }),
      "127.0.0.1",
      0,
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const dispatcher = new BridgeDispatcher({
      integrationUrl: `http://127.0.0.1:${address.port}`,
      privateKey: loadPrivateKey(privatePath),
      sandboxId: "sandbox",
      workspaceId: "workspace",
      audit: new AuditLog(join(dir, "host-audit.jsonl")),
    });
    const first = dispatcher.dispatch({
      event_id: "first-event",
      platform: "slack",
      user_id: "user",
      channel_id: "channel",
      conversation_id: "thread",
      message: "first",
    });
    await firstStarted;
    const second = dispatcher.dispatch({
      event_id: "second-event",
      platform: "slack",
      user_id: "user",
      channel_id: "channel",
      conversation_id: "thread",
      message: "second",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(messages).toEqual(["first"]);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(messages).toEqual(["first", "second"]);
    expect(maximumActive).toBe(1);
  });

  it("validates attachment digests and deduplicates with bounds", () => {
    const content = Buffer.from("hello");
    const digest = createHash("sha256").update(content).digest("hex");
    expect(
      decodeOutboundAttachments([
        {
          name: "../safe.txt",
          sha256: digest,
          content_b64: content.toString("base64"),
        },
      ]),
    ).toEqual([{ name: "safe.txt", content }]);
    expect(
      decodeOutboundAttachments([
        {
          name: "bad",
          sha256: "wrong",
          content_b64: content.toString("base64"),
        },
      ]),
    ).toEqual([]);
    const dedupe = new EventDeduplicator(1, 10);
    expect(dedupe.accept("one", 0)).toBe(true);
    expect(dedupe.accept("one", 1)).toBe(false);
    expect(dedupe.accept("two", 2)).toBe(true);
    expect(dedupe.accept("one", 3)).toBe(true);
  });

  it("transfers inbound attachments then removes plaintext", async () => {
    const dir = root();
    const [privatePath, publicPath] = generateKeypair(join(dir, "keys"));
    let received: Record<string, unknown> = {};
    const remote: XangiLike = {
      async createSession() {
        return "unused";
      },
      async turn() {
        return "unused";
      },
      async *remoteTurn(body): AsyncGenerator<SseEvent> {
        received = body;
        yield { event: "done", response: "ok" };
      },
    };
    const integration = new Integration({
      sandboxId: "sandbox",
      workspaceId: "workspace",
      publicKey: loadPublicKey(publicPath),
      xangi: remote,
      stateDir: dir,
    });
    const token = issue(loadPrivateKey(privatePath), {
      audience: "integration",
      sandboxId: "sandbox",
      sessionId: "c",
      subject: { platform: "slack", user_id: "u", channel_id: "ch" },
      workspaceId: "workspace",
      grants: [
        { capability: "xangi", actions: ["turn"], resources: ["workspace"] },
      ],
    });
    const content = Buffer.from("attachment");
    const [status] = await integration.turn(token, {
      platform: "slack",
      user_id: "u",
      channel_id: "ch",
      message: "look",
      attachments: [
        {
          name: "../note.txt",
          content_b64: content.toString("base64"),
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      ],
    });
    expect(status).toBe(200);
    expect(received.attachments).toHaveLength(1);
    expect(existsSync(String((received.attachments as string[])[0]))).toBe(
      false,
    );
  });
});
