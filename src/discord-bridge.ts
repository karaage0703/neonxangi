import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BridgeDispatcher, InboundEvent } from "./bridge.js";
import { decodeOutboundAttachments } from "./bridge.js";

const MIB = 1024 * 1024;

export interface DiscordBridgeOptions {
  dispatcher: BridgeDispatcher;
  allowedUsers: Set<string>;
  allowedBots: Set<string>;
  allowedChannels: Set<string>;
  autoReplyChannels: Set<string>;
  botMaxConsecutive: number;
  quarantineDir: string;
  client?: Client;
}

export class DiscordBridge {
  readonly client: Client;
  private readonly botReplyCounts = new Map<string, number>();

  constructor(readonly options: DiscordBridgeOptions) {
    this.client =
      options.client ??
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel, Partials.Message],
      });
    this.client.on(Events.MessageCreate, (message) => {
      void this.processMessage(message).catch((error: unknown) => {
        console.error(`Neon Xangi Discord handler failed: ${String(error)}`);
      });
    });
  }

  async start(token: string): Promise<void> {
    await this.client.login(token);
  }

  stop(): Promise<void> {
    return this.client.destroy();
  }

  async processMessage(message: Message): Promise<void> {
    const userId = message.author.id;
    const channelId = message.channel.id;
    const parentId = message.channel.isThread()
      ? (message.channel.parentId ?? "")
      : "";
    const ownUser = this.client.user;
    if (message.author.bot && ownUser && userId === ownUser.id) return;
    if (
      !this.options.allowedChannels.has(channelId) &&
      !this.options.allowedChannels.has(parentId)
    ) {
      this.options.dispatcher.input.audit.write({
        component: "bridge",
        action: "discord.receive",
        outcome: "denied",
        subject: { platform: "discord", user_id: userId },
        resource: channelId,
      });
      return;
    }
    if (message.author.bot) {
      const key = `${channelId}:${userId}`;
      if (!this.options.allowedBots.has(userId)) return;
      const count = this.botReplyCounts.get(key) ?? 0;
      if (count >= this.options.botMaxConsecutive) {
        this.options.dispatcher.input.audit.write({
          component: "bridge",
          action: "discord.receive",
          outcome: "denied",
          subject: { platform: "discord", user_id: userId },
          resource: channelId,
          details: { reason: "bot consecutive reply limit reached" },
        });
        return;
      }
      this.botReplyCounts.set(key, count + 1);
    } else {
      this.botReplyCounts.clear();
      if (!this.options.allowedUsers.has(userId)) {
        this.options.dispatcher.input.audit.write({
          component: "bridge",
          action: "discord.receive",
          outcome: "denied",
          subject: { platform: "discord", user_id: userId },
          resource: channelId,
        });
        return;
      }
    }
    const settingsChannelId = parentId || channelId;
    const direct = message.guildId === null;
    const mentioned = Boolean(
      ownUser && message.mentions.users.has(ownUser.id),
    );
    if (
      !direct &&
      !mentioned &&
      !this.options.autoReplyChannels.has(settingsChannelId) &&
      !message.channel.isThread()
    ) {
      return;
    }
    const attachmentPaths = await this.downloadAttachments(message);
    const parentName = message.channel.isThread()
      ? (message.channel.parent?.name ?? "")
      : "";
    const channelName =
      "name" in message.channel ? String(message.channel.name ?? "") : "";
    const inbound: InboundEvent = {
      event_id: message.id,
      platform: "discord",
      user_id: userId,
      channel_id: channelId,
      conversation_id: channelId,
      message: ownUser
        ? message.content.replaceAll(`<@${ownUser.id}>`, "").trim()
        : message.content,
      message_id: message.id,
      user_name:
        message.member?.displayName ??
        message.author.displayName ??
        message.author.username,
      settings_channel_id: settingsChannelId,
      channel_name: channelName,
      thread_id: message.channel.isThread() ? channelId : "",
      thread_name: message.channel.isThread() ? channelName : "",
      parent_channel_name: parentName,
      attachments: attachmentPaths,
    };
    await message.react("👀").catch(() => undefined);
    try {
      await this.dispatchAndRender(message, inbound);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await message.reply({
        content: `Neon Xangi bridge error: ${detail}`,
        allowedMentions: { repliedUser: false },
      });
    } finally {
      if (ownUser) {
        const reaction = message.reactions.cache.find(
          (item) => item.emoji.name === "👀",
        );
        await reaction?.users.remove(ownUser.id).catch(() => undefined);
      }
      if (attachmentPaths.length > 0) {
        rmSync(join(this.options.quarantineDir, message.id), {
          recursive: true,
          force: true,
        });
      }
    }
  }

  private async downloadAttachments(message: Message): Promise<string[]> {
    if (message.attachments.size === 0) return [];
    const target = join(this.options.quarantineDir, message.id);
    const paths: string[] = [];
    for (const attachment of [...message.attachments.values()].slice(0, 10)) {
      if (attachment.size > 25 * MIB) continue;
      const url = new URL(attachment.url);
      if (
        url.protocol !== "https:" ||
        !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
      ) {
        continue;
      }
      const response = await fetch(url, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) continue;
      const content = Buffer.from(await response.arrayBuffer());
      if (content.length > 25 * MIB) continue;
      mkdirSync(target, { recursive: true, mode: 0o700 });
      const name = basename(attachment.name || "file");
      const path = join(
        target,
        name && ![".", ".."].includes(name) ? name : "file",
      );
      writeFileSync(path, content, { mode: 0o600 });
      chmodSync(path, 0o600);
      paths.push(path);
    }
    return paths;
  }

  private async dispatchAndRender(
    message: Message,
    event: InboundEvent,
  ): Promise<void> {
    let replyMessage: Message | undefined;
    let latestText = "";
    let attachments: ReturnType<typeof decodeOutboundAttachments> = [];
    let lastEdit = 0;
    const update = async (content: string, final = false): Promise<void> => {
      const visible = content.trim() || "💭 考え中…";
      const now = Date.now();
      if (!replyMessage) {
        replyMessage = await message.reply({
          content: visible.slice(0, 2000),
          allowedMentions: { repliedUser: false },
        });
        lastEdit = now;
      } else if (final || now - lastEdit >= 750) {
        await replyMessage.edit({ content: visible.slice(0, 2000) });
        lastEdit = now;
      }
    };
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
      if (message.channel.isSendable()) {
        for (let offset = 2000; offset < finalText.length; offset += 2000) {
          await message.channel.send(finalText.slice(offset, offset + 2000));
        }
      }
    }
    if (message.channel.isSendable()) {
      for (const attachment of attachments) {
        await message.channel.send({
          files: [
            new AttachmentBuilder(attachment.content, {
              name: attachment.name,
            }),
          ],
        });
      }
    }
  }
}
