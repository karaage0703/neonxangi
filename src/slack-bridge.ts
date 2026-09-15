import { App, LogLevel } from "@slack/bolt";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BridgeDispatcher, InboundEvent } from "./bridge.js";
import { BridgeError, decodeOutboundAttachments } from "./bridge.js";

const MIB = 1024 * 1024;

type SlackRecord = Record<string, unknown>;
interface UploadClient {
  filesUploadV2(args: Record<string, unknown>): Promise<unknown>;
}

export interface SlackBridgeOptions {
  dispatcher: BridgeDispatcher;
  botToken: string;
  appToken: string;
  allowedUsers: Set<string>;
  allowedChannels: Set<string>;
  autoReplyChannels: Set<string>;
  quarantineDir: string;
  app?: App;
}

export class SlackBridge {
  readonly app: App;
  private botUserId = "";

  constructor(readonly options: SlackBridgeOptions) {
    this.app =
      options.app ??
      new App({
        token: options.botToken,
        appToken: options.appToken,
        socketMode: true,
        logLevel: LogLevel.WARN,
      });
    this.app.event("message", async ({ event }) => {
      await this.processEvent(event as unknown as SlackRecord);
    });
    this.app.event("app_mention", async ({ event }) => {
      await this.processEvent(event as unknown as SlackRecord);
    });
  }

  async start(): Promise<void> {
    const identity = await this.app.client.auth.test();
    this.botUserId = String(identity.user_id ?? "");
    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  async processEvent(event: SlackRecord): Promise<void> {
    const eventType = String(event.type ?? "");
    if (!["app_mention", "message"].includes(eventType)) return;
    if (
      ![undefined, null, "file_share", "me_message"].includes(
        event.subtype as string | null | undefined,
      )
    )
      return;
    if (event.bot_id) return;
    const userId = String(event.user ?? "");
    const channelId = String(event.channel ?? "");
    const messageTs = String(event.ts ?? "");
    if (!userId || !channelId || !messageTs || userId === this.botUserId)
      return;
    if (
      !this.options.allowedUsers.has(userId) ||
      !this.options.allowedChannels.has(channelId)
    )
      return;
    const direct = event.channel_type === "im";
    const threadTs = String(event.thread_ts ?? "");
    if (
      eventType !== "app_mention" &&
      !direct &&
      !this.options.autoReplyChannels.has(channelId) &&
      !threadTs
    ) {
      return;
    }
    const text = String(event.text ?? "")
      .replaceAll(/<@[A-Z0-9]+>/gu, "")
      .trim();
    if (!text && !event.files) return;
    const attachmentPaths = await this.downloadFiles(event.files, messageTs);
    const inbound: InboundEvent = {
      event_id: `${channelId}:${messageTs}`,
      platform: "slack",
      user_id: userId,
      channel_id: channelId,
      conversation_id: threadTs ? `${channelId}:${threadTs}` : channelId,
      message: text || "添付ファイルを確認してください",
      message_id: messageTs,
      user_name: userId,
      settings_channel_id: channelId,
      channel_name: channelId,
      thread_id: threadTs,
      attachments: attachmentPaths,
    };
    try {
      await this.dispatchAndRender(inbound, messageTs, threadTs || messageTs);
    } finally {
      if (attachmentPaths.length > 0) {
        rmSync(
          join(this.options.quarantineDir, messageTs.replaceAll(".", "-")),
          {
            recursive: true,
            force: true,
          },
        );
      }
    }
  }

  private async downloadFiles(
    raw: unknown,
    messageTs: string,
  ): Promise<string[]> {
    if (!Array.isArray(raw)) return [];
    const destination = join(
      this.options.quarantineDir,
      messageTs.replaceAll(".", "-"),
    );
    const paths: string[] = [];
    for (const rawItem of raw.slice(0, 10)) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem))
        continue;
      const item = rawItem as SlackRecord;
      const urlValue = String(
        item.url_private_download ?? item.url_private ?? "",
      );
      let url: URL;
      try {
        url = new URL(urlValue);
      } catch {
        continue;
      }
      if (
        url.protocol !== "https:" ||
        !(url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"))
      ) {
        continue;
      }
      const declaredSize = Number(item.size ?? 0);
      if (!Number.isFinite(declaredSize) || declaredSize > 25 * MIB) continue;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.options.botToken}` },
        signal: AbortSignal.timeout(60_000),
      }).catch(() => undefined);
      if (!response?.ok) continue;
      const content = Buffer.from(await response.arrayBuffer());
      if (content.length > 25 * MIB) continue;
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      const candidate = basename(String(item.name ?? "file"));
      const name =
        candidate && ![".", ".."].includes(candidate) ? candidate : "file";
      const path = join(destination, name);
      writeFileSync(path, content, { mode: 0o600 });
      chmodSync(path, 0o600);
      paths.push(path);
    }
    return paths;
  }

  private async dispatchAndRender(
    event: InboundEvent,
    sourceTs: string,
    responseThreadTs: string,
  ): Promise<void> {
    const channel = event.channel_id;
    await this.app.client.reactions
      .add({ channel, timestamp: sourceTs, name: "eyes" })
      .catch(() => undefined);
    let responseTs = "";
    let latestText = "";
    let attachments: ReturnType<typeof decodeOutboundAttachments> = [];
    let lastUpdate = 0;
    const update = async (text: string, final = false): Promise<void> => {
      const visible = (text.trim() || "💭 考え中…").slice(0, 4000);
      const now = Date.now();
      if (!responseTs) {
        const response = await this.app.client.chat.postMessage({
          channel,
          thread_ts: responseThreadTs,
          text: visible,
        });
        responseTs = String(response.ts ?? "");
        lastUpdate = now;
      } else if (final || now - lastUpdate >= 750) {
        await this.app.client.chat.update({
          channel,
          ts: responseTs,
          text: visible,
        });
        lastUpdate = now;
      }
    };
    try {
      const reply = await this.options.dispatcher.dispatch(
        event,
        async (value) => {
          if (value.event === "started") await update("💭 考え中…");
          else if (value.event === "text") {
            latestText = String(value.fullText ?? "");
            await update(latestText);
          } else if (value.event === "tool" && !latestText) {
            await update(`🔧 ${String(value.toolName ?? "tool")} を実行中…`);
          } else if (value.event === "done") {
            attachments = [
              ...attachments,
              ...decodeOutboundAttachments(value.attachments),
            ];
          }
        },
      );
      const finalText = reply ?? latestText;
      if (finalText) {
        await update(finalText, true);
        for (let offset = 4000; offset < finalText.length; offset += 4000) {
          await this.app.client.chat.postMessage({
            channel,
            thread_ts: responseThreadTs,
            text: finalText.slice(offset, offset + 4000),
          });
        }
      }
      const uploadClient = this.app.client as unknown as UploadClient;
      for (const attachment of attachments) {
        await uploadClient.filesUploadV2({
          channel,
          thread_ts: responseThreadTs,
          file: attachment.content,
          filename: attachment.name,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await update(`Neon Xangi bridge error: ${detail}`, true);
      if (!(error instanceof BridgeError)) throw error;
    } finally {
      await this.app.client.reactions
        .remove({ channel, timestamp: sourceTs, name: "eyes" })
        .catch(() => undefined);
    }
  }
}
