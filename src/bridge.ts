import { createHash, randomUUID, type KeyObject } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { AuditLog } from "./audit.js";
import { issue } from "./capability.js";
import { parseSse, type SseEvent } from "./http.js";

const MIB = 1024 * 1024;

export class BridgeError extends Error {}

export interface EncodedAttachment {
  name: string;
  size: number;
  sha256: string;
  content_b64: string;
}

export interface DecodedAttachment {
  name: string;
  content: Buffer;
}

export function decodeOutboundAttachments(raw: unknown): DecodedAttachment[] {
  if (!Array.isArray(raw)) return [];
  const decoded: DecodedAttachment[] = [];
  let total = 0;
  for (const rawItem of raw.slice(0, 10)) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem))
      continue;
    const item = rawItem as Record<string, unknown>;
    const encoded = String(item.content_b64 ?? "");
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        encoded,
      )
    )
      continue;
    const content = Buffer.from(encoded, "base64");
    if (content.length > 25 * MIB) continue;
    total += content.length;
    if (total > 50 * MIB) break;
    const digest = String(item.sha256 ?? "");
    if (digest && createHash("sha256").update(content).digest("hex") !== digest)
      continue;
    const candidate = basename(String(item.name ?? "file"));
    decoded.push({
      name: candidate && ![".", ".."].includes(candidate) ? candidate : "file",
      content,
    });
  }
  return decoded;
}

export interface InboundEvent {
  event_id: string;
  platform: string;
  user_id: string;
  channel_id: string;
  conversation_id: string;
  message: string;
  message_id?: string;
  user_name?: string;
  settings_channel_id?: string;
  channel_name?: string;
  thread_id?: string;
  thread_name?: string;
  parent_channel_name?: string;
  attachments?: string[];
}

export class EventDeduplicator {
  private readonly events = new Map<string, number>();

  constructor(
    readonly maximum = 10_000,
    readonly ttlMilliseconds = 86_400_000,
  ) {}

  accept(eventId: string, now = Date.now()): boolean {
    for (const [id, timestamp] of this.events) {
      if (timestamp < now - this.ttlMilliseconds) this.events.delete(id);
      else break;
    }
    if (this.events.has(eventId)) return false;
    this.events.set(eventId, now);
    while (this.events.size > this.maximum) {
      const oldest = this.events.keys().next().value as string | undefined;
      if (!oldest) break;
      this.events.delete(oldest);
    }
    return true;
  }
}

export type BridgeEventHandler = (event: SseEvent) => void | Promise<void>;

export class BridgeDispatcher {
  readonly integrationUrl: string;
  readonly deduplicator = new EventDeduplicator();
  private readonly conversationTails = new Map<string, Promise<void>>();

  constructor(
    readonly input: {
      integrationUrl: string;
      privateKey: KeyObject;
      sandboxId: string;
      workspaceId: string;
      audit: AuditLog;
    },
  ) {
    const url = new URL(input.integrationUrl);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "::1", "localhost"].includes(url.hostname)
    ) {
      throw new BridgeError("Integration URL must be loopback HTTP");
    }
    this.integrationUrl = input.integrationUrl.replace(/\/$/u, "");
  }

  async dispatch(
    event: InboundEvent,
    onEvent?: BridgeEventHandler,
  ): Promise<string | undefined> {
    if (!this.deduplicator.accept(event.event_id)) {
      this.input.audit.write({
        component: "bridge",
        action: "event.receive",
        outcome: "duplicate",
        subject: { platform: event.platform, user_id: event.user_id },
        resource: event.channel_id,
      });
      return undefined;
    }
    const conversationKey = [
      event.platform,
      event.channel_id,
      event.conversation_id,
    ].join(":");
    return await this.serializeConversation(conversationKey, () =>
      this.forward(event, onEvent),
    );
  }

  private async serializeConversation<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.conversationTails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => completion);
    this.conversationTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.conversationTails.get(key) === tail)
        this.conversationTails.delete(key);
    }
  }

  private async forward(
    event: InboundEvent,
    onEvent?: BridgeEventHandler,
  ): Promise<string> {
    const correlationId = `nx-${randomUUID().replaceAll("-", "")}`;
    const token = issue(this.input.privateKey, {
      audience: "integration",
      sandboxId: this.input.sandboxId,
      sessionId: event.conversation_id,
      subject: {
        platform: event.platform,
        user_id: event.user_id,
        channel_id: event.channel_id,
      },
      workspaceId: this.input.workspaceId,
      grants: [
        {
          capability: "xangi",
          actions: ["turn"],
          resources: [this.input.workspaceId],
        },
      ],
      ttlSeconds: 120,
    });
    const attachments: EncodedAttachment[] = [];
    let total = 0;
    for (const source of (event.attachments ?? []).slice(0, 10)) {
      const path = resolve(source);
      const size = statSync(path).size;
      if (size > 25 * MIB)
        throw new BridgeError(`attachment exceeds 25 MiB: ${basename(path)}`);
      total += size;
      if (total > 50 * MIB)
        throw new BridgeError("attachments exceed the 50 MiB turn limit");
      const content = readFileSync(path);
      attachments.push({
        name: basename(path),
        size,
        sha256: createHash("sha256").update(content).digest("hex"),
        content_b64: content.toString("base64"),
      });
    }
    const body = {
      platform: event.platform,
      user_id: event.user_id,
      channel_id: event.channel_id,
      conversation_id: event.conversation_id,
      message: event.message,
      event_id: event.event_id,
      message_id: event.message_id ?? event.event_id,
      user_name: event.user_name ?? event.user_id,
      settings_channel_id: event.settings_channel_id ?? event.channel_id,
      channel_name: event.channel_name ?? "",
      thread_id: event.thread_id ?? "",
      thread_name: event.thread_name ?? "",
      parent_channel_name: event.parent_channel_name ?? "",
      attachments,
      correlation_id: correlationId,
    };
    this.input.audit.write({
      component: "bridge",
      action: "event.forward",
      outcome: "started",
      subject: { platform: event.platform, user_id: event.user_id },
      resource: event.channel_id,
      correlationId,
    });
    let response: Response;
    try {
      response = await fetch(`${this.integrationUrl}/v1/turn`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(900_000),
      });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      let reply = "";
      for await (const value of parseSse(response)) {
        if (onEvent) await onEvent(value);
        if (value.event === "error")
          throw new BridgeError(
            String(value.message ?? "integration turn failed"),
          );
        if (value.event === "done") {
          reply = String(value.response ?? "").trim();
          break;
        }
      }
      if (!reply)
        throw new BridgeError("integration returned an empty response");
      this.input.audit.write({
        component: "bridge",
        action: "event.forward",
        outcome: "completed",
        resource: event.channel_id,
        correlationId,
      });
      return reply;
    } catch (error) {
      this.input.audit.write({
        component: "bridge",
        action: "event.forward",
        outcome: "failed",
        resource: event.channel_id,
        correlationId,
        details: {
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(`integration request failed: ${String(error)}`);
    }
  }
}
