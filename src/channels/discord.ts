/**
 * Discord channel implementation using discord.js.
 * Mirrors nanobot/channels/discord.py
 */

import {
  Client,
  GatewayIntentBits,
  Events,
  type Message,
  type TextChannel,
  type DMChannel,
  type NewsChannel,
  type ThreadChannel,
} from "discord.js";
import { logger } from "../utils/logger.js";
import { BaseChannel } from "./base.js";
import type { MessageBus } from "../bus/queue.js";
import type { OutboundMessage } from "../bus/events.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCORD_MAX_MSG_LEN = 2000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DiscordConfig {
  enabled?: boolean;
  token?: string;
  allowFrom?: string[];
  /** discord.Intents bitmask (default: 37377 = Guilds + GuildMessages + MessageContent + DirectMessages) */
  intents?: number;
  groupPolicy?: "open" | "mention";
  readReceiptEmoji?: string;
}

// ---------------------------------------------------------------------------
// DiscordChannel
// ---------------------------------------------------------------------------

export class DiscordChannel extends BaseChannel {
  static override readonly channelName = "discord";
  static override readonly displayName = "Discord";

  declare readonly config: DiscordConfig & Record<string, unknown>;

  private _client: Client | null = null;
  private _botUserId: string | null = null;

  constructor(config: Record<string, unknown>, bus: MessageBus) {
    super(config, bus);
  }

  // ---------------------------------------------------------------------------
  // start / stop
  // ---------------------------------------------------------------------------

  override async start(): Promise<void> {
    const token = this.config["token"] as string | undefined;
    if (!token) { logger.error("Discord token not configured"); return; }

    this._running = true;

    const intentBits = (this.config["intents"] as number | undefined) ?? 37377;
    this._client = new Client({ intents: intentBits });

    this._client.once(Events.ClientReady, (client) => {
      this._botUserId = client.user.id;
      logger.info({ username: client.user.tag }, "Discord bot connected");
    });

    this._client.on(Events.MessageCreate, (msg) => {
      this._onMessage(msg).catch((e) => logger.error({ err: e }, "Discord message handler error"));
    });

    this._client.on(Events.Error, (e) => logger.error({ err: e }, "Discord client error"));

    await this._client.login(token);
    logger.info("Discord bot logged in, awaiting ready…");

    // Block until stopped
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this._running) { clearInterval(check); resolve(); }
      }, 1000);
    });
  }

  override async stop(): Promise<void> {
    this._running = false;
    if (this._client) {
      await this._client.destroy();
      this._client = null;
    }
  }

  // ---------------------------------------------------------------------------
  // send
  // ---------------------------------------------------------------------------

  override async send(msg: OutboundMessage): Promise<void> {
    if (!this._client) return;

    // chatId is the Discord channel/thread ID
    let channel: TextChannel | DMChannel | NewsChannel | ThreadChannel | null = null;
    try {
      const resolved = await this._client.channels.fetch(msg.chatId);
      if (!resolved?.isTextBased()) {
        logger.warn({ chatId: msg.chatId }, "Discord channel not text-based");
        return;
      }
      channel = resolved as TextChannel | DMChannel | NewsChannel | ThreadChannel;
    } catch (e) {
      logger.error({ err: e, chatId: msg.chatId }, "Discord channel fetch failed");
      return;
    }

    // Media attachments
    const files: { attachment: Buffer | string; name: string }[] = [];
    for (const mediaPath of msg.media ?? []) {
      try {
        files.push({ attachment: mediaPath, name: mediaPath.split("/").pop() ?? "file" });
      } catch (e) {
        logger.error({ err: e, mediaPath }, "Discord media attach failed");
      }
    }

    // Split long text
    const chunks = splitMessage(msg.content ?? "", DISCORD_MAX_MSG_LEN);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const sendFiles = i === chunks.length - 1 ? files : [];
      try {
        if (sendFiles.length > 0) {
          await channel.send({ content: chunk || " ", files: sendFiles });
        } else if (chunk) {
          await channel.send(chunk);
        }
      } catch (e) {
        logger.error({ err: e, chatId: msg.chatId }, "Discord send failed");
        throw e;
      }
    }

    // If no content but has files, send files only
    if (!msg.content && files.length > 0) {
      try {
        await channel.send({ files });
      } catch (e) {
        logger.error({ err: e, chatId: msg.chatId }, "Discord file send failed");
        throw e;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------

  private async _onMessage(message: Message): Promise<void> {
    // Ignore bot's own messages
    if (message.author.bot) return;
    if (this._botUserId && message.author.id === this._botUserId) return;

    const senderId = message.author.id;
    const chatId = message.channelId;
    const isGroup = message.guild != null;

    if (isGroup) {
      if (!await this._isGroupMessageForBot(message)) return;
    }

    const content = message.content || "[empty message]";
    const metadata: Record<string, unknown> = {
      message_id: message.id,
      user_id: message.author.id,
      username: message.author.username,
      is_group: isGroup,
      guild_id: message.guildId ?? null,
    };

    // Read receipt emoji (best effort)
    const emoji = (this.config["readReceiptEmoji"] as string | undefined) ?? "👀";
    if (emoji) {
      message.react(emoji).catch(() => { /* ignore */ });
    }

    await this._handleMessage({ senderId, chatId, content, metadata });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async _isGroupMessageForBot(message: Message): Promise<boolean> {
    const policy = (this.config["groupPolicy"] as string | undefined) ?? "mention";
    if (policy === "open") return true;

    // Check for bot mention
    if (this._botUserId && message.mentions.users.has(this._botUserId)) return true;

    // Check for reply to bot
    if (message.reference?.messageId) {
      try {
        const replied = await message.channel.messages.fetch(message.reference.messageId);
        if (replied.author.id === this._botUserId) return true;
      } catch { /* ignore */ }
    }

    return false;
  }
}

// ---------------------------------------------------------------------------
// Split long message at word boundary
// ---------------------------------------------------------------------------

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
