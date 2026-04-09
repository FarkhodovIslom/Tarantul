/**
 * Telegram channel implementation using grammY.
 * Mirrors nanobot/channels/telegram.py
 *
 * Transport: long polling (no webhook / public IP needed).
 * Streaming: progressive message editing at STREAM_EDIT_INTERVAL_MS cadence.
 */

import { Bot, Context, InputFile } from "grammy";
import type { Message, User } from "@grammyjs/types";
import { logger } from "../utils/logger.js";
import { BaseChannel } from "./base.js";
import type { MessageBus } from "../bus/queue.js";
import type { OutboundMessage } from "../bus/events.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TELEGRAM_MAX_MSG_LEN = 4000;
const STREAM_EDIT_INTERVAL_MS = 600;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TelegramConfig {
  enabled?: boolean;
  token?: string;
  allowFrom?: string[];
  proxy?: string | null;
  replyToMessage?: boolean;
  reactEmoji?: string;
  groupPolicy?: "open" | "mention";
  streaming?: boolean;
}

// ---------------------------------------------------------------------------
// Stream accumulator
// ---------------------------------------------------------------------------

interface StreamBuf {
  text: string;
  messageId: number | null;
  lastEditMs: number;
  streamId: string | null;
}

// ---------------------------------------------------------------------------
// Markdown → Telegram HTML
// ---------------------------------------------------------------------------

function mdToHtml(text: string): string {
  if (!text) return "";

  // 1. Save code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code: string) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Save inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code: string) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Headers → plain text
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // 4. Blockquotes → plain text
  text = text.replace(/^>\s*(.*)$/gm, "$1");

  // 5. Escape HTML
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 6. Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 7. Bold
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  // 8. Italic (_word_ only, not inside identifiers)
  text = text.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "<i>$1</i>");

  // 9. Strikethrough
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 10. Bullet lists
  text = text.replace(/^[-*]\s+/gm, "• ");

  // 11. Restore inline code
  inlineCodes.forEach((code, i) => {
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(`\x00IC${i}\x00`, `<code>${escaped}</code>`);
  });

  // 12. Restore code blocks
  codeBlocks.forEach((code, i) => {
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(`\x00CB${i}\x00`, `<pre><code>${escaped}</code></pre>`);
  });

  return text;
}

// ---------------------------------------------------------------------------
// splitMessage — splits long text at word boundary
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

// ---------------------------------------------------------------------------
// TelegramChannel
// ---------------------------------------------------------------------------

export class TelegramChannel extends BaseChannel {
  static override readonly channelName = "telegram";
  static override readonly displayName = "Telegram";

  declare readonly config: TelegramConfig & Record<string, unknown>;

  private _bot: Bot | null = null;
  private _botUserId: number | null = null;
  private _botUsername: string | null = null;
  private readonly _typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly _streamBufs = new Map<string, StreamBuf>();
  /** chatId → pending media group contents */
  private readonly _mediaGroups = new Map<string, {
    senderId: string; chatId: string;
    contents: string[]; media: string[];
    metadata: Record<string, unknown>;
    sessionKey?: string;
    timer?: ReturnType<typeof setTimeout>;
  }>();

  constructor(config: Record<string, unknown>, bus: MessageBus) {
    super(config, bus);
  }

  // ---------------------------------------------------------------------------
  // allow-list: supports "userId|username" format
  // ---------------------------------------------------------------------------

  override isAllowed(senderId: string): boolean {
    if (super.isAllowed(senderId)) return true;
    const allowFrom = (this.config["allowFrom"] as string[] | undefined) ?? [];
    if (!allowFrom.length || allowFrom.includes("*")) return false;
    if (!senderId.includes("|")) return false;
    const [id, username] = senderId.split("|", 2) as [string, string];
    if (!id || !username) return false;
    return allowFrom.includes(id) || allowFrom.includes(username);
  }

  // ---------------------------------------------------------------------------
  // start / stop
  // ---------------------------------------------------------------------------

  override async start(): Promise<void> {
    const token = this.config["token"] as string | undefined;
    if (!token) { logger.error("Telegram token not configured"); return; }

    this._running = true;

    this._bot = new Bot(token);
    const bot = this._bot;

    // Command handlers
    bot.command("start", (ctx) => this._onStart(ctx));
    bot.command("help", (ctx) => this._onHelp(ctx));
    for (const cmd of ["new", "stop", "restart", "status"]) {
      bot.command(cmd, (ctx) => this._forwardCommand(ctx));
    }

    // Message handler (text + photos + voice + documents)
    bot.on("message", (ctx) => this._onMessage(ctx));

    bot.catch((err) => logger.error({ err }, "Telegram bot error"));

    logger.info("Starting Telegram bot (polling)…");
    await bot.start({
      drop_pending_updates: true,
      onStart: async (info) => {
        this._botUserId = info.id;
        this._botUsername = info.username;
        logger.info({ username: info.username }, "Telegram bot connected");
        try {
          await bot.api.setMyCommands([
            { command: "start", description: "Start the bot" },
            { command: "new", description: "New conversation" },
            { command: "stop", description: "Stop current task" },
            { command: "restart", description: "Restart the bot" },
            { command: "status", description: "Show status" },
            { command: "help", description: "Show help" },
          ]);
        } catch (e) {
          logger.warn({ err: e }, "Failed to register Telegram commands");
        }
      },
    });
  }

  override async stop(): Promise<void> {
    this._running = false;
    for (const timer of this._typingTimers.values()) clearInterval(timer);
    this._typingTimers.clear();
    for (const g of this._mediaGroups.values()) {
      if (g.timer) clearTimeout(g.timer);
    }
    this._mediaGroups.clear();
    if (this._bot) {
      await this._bot.stop();
      this._bot = null;
    }
  }

  // ---------------------------------------------------------------------------
  // send (outbound)
  // ---------------------------------------------------------------------------

  override async send(msg: OutboundMessage): Promise<void> {
    if (!this._bot) return;

    // Stop typing on final response
    if (!msg.metadata?.["_progress"]) this._stopTyping(msg.chatId);

    const chatId = parseInt(msg.chatId, 10);
    if (isNaN(chatId)) { logger.error({ chatId: msg.chatId }, "Invalid Telegram chat_id"); return; }

    const threadId = (msg.metadata?.["message_thread_id"] as number | undefined) ?? undefined;
    const replyToId = (msg.metadata?.["message_id"] as number | undefined) ?? undefined;

    const extra: Record<string, unknown> = {};
    if (threadId != null) extra["message_thread_id"] = threadId;

    const replyParams = (this.config["replyToMessage"] && replyToId != null)
      ? { reply_parameters: { message_id: replyToId, allow_sending_without_reply: true } }
      : {};

    // Media attachments
    for (const mediaPath of msg.media ?? []) {
      try {
        const isUrl = mediaPath.startsWith("http://") || mediaPath.startsWith("https://");
        const ext = mediaPath.split(".").pop()?.toLowerCase() ?? "";
        const isPhoto = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext);
        const file = isUrl ? mediaPath : new InputFile(new Uint8Array(await Bun.file(mediaPath).arrayBuffer()));
        if (isPhoto) {
          await this._bot.api.sendPhoto(chatId, file, { ...extra, ...replyParams } as never);
        } else {
          await this._bot.api.sendDocument(chatId, file, { ...extra, ...replyParams } as never);
        }
      } catch (e) {
        logger.error({ err: e, mediaPath }, "Failed to send Telegram media");
      }
    }

    // Text content
    if (msg.content && msg.content !== "[empty message]") {
      for (const chunk of splitMessage(msg.content, TELEGRAM_MAX_MSG_LEN)) {
        await this._sendText(chatId, chunk, { ...extra, ...replyParams });
      }
    }
  }

  private async _sendText(chatId: number, text: string, extra: Record<string, unknown>): Promise<void> {
    if (!this._bot) return;
    try {
      const html = mdToHtml(text);
      await this._bot.api.sendMessage(chatId, html, { parse_mode: "HTML", ...extra } as never);
    } catch {
      try {
        await this._bot.api.sendMessage(chatId, text, extra as never);
      } catch (e2) {
        logger.error({ err: e2, chatId }, "Failed to send Telegram message");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // sendDelta (streaming)
  // ---------------------------------------------------------------------------

  override async sendDelta(chatId: string, delta: string, metadata?: Record<string, unknown>): Promise<void> {
    if (!this._bot) return;
    const meta = metadata ?? {};
    const intId = parseInt(chatId, 10);
    if (isNaN(intId)) return;
    const streamId = (meta["_stream_id"] as string | undefined) ?? null;

    if (meta["_stream_end"]) {
      const buf = this._streamBufs.get(chatId);
      if (!buf?.messageId || !buf.text) return;
      if (streamId != null && buf.streamId != null && buf.streamId !== streamId) return;
      this._stopTyping(chatId);
      try {
        const html = mdToHtml(buf.text);
        await this._bot.api.editMessageText(intId, buf.messageId, html, { parse_mode: "HTML" } as never);
      } catch {
        try {
          await this._bot.api.editMessageText(intId, buf.messageId, buf.text);
        } catch (e2) {
          logger.warn({ err: e2, chatId }, "Telegram final stream edit failed");
        }
      }
      this._streamBufs.delete(chatId);
      return;
    }

    let buf = this._streamBufs.get(chatId);
    if (!buf || (streamId != null && buf.streamId != null && buf.streamId !== streamId)) {
      buf = { text: "", messageId: null, lastEditMs: 0, streamId };
      this._streamBufs.set(chatId, buf);
    }
    buf.text += delta;
    if (!buf.text.trim()) return;

    const now = Date.now();
    if (buf.messageId === null) {
      try {
        const sent = await this._bot.api.sendMessage(intId, buf.text);
        buf.messageId = sent.message_id;
        buf.lastEditMs = now;
      } catch (e) {
        logger.warn({ err: e, chatId }, "Telegram stream initial send failed");
        throw e;
      }
    } else if (now - buf.lastEditMs >= STREAM_EDIT_INTERVAL_MS) {
      try {
        await this._bot.api.editMessageText(intId, buf.messageId, buf.text);
        buf.lastEditMs = now;
      } catch (e) {
        const msg = String(e);
        if (msg.toLowerCase().includes("message is not modified")) {
          buf.lastEditMs = now;
          return;
        }
        logger.warn({ err: e, chatId }, "Telegram stream edit failed");
        throw e;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Command / message handlers
  // ---------------------------------------------------------------------------

  private async _onStart(ctx: Context): Promise<void> {
    const name = ctx.from?.first_name ?? "friend";
    await ctx.reply(`👋 Hi ${name}! I'm nanobot.\nSend me a message and I'll respond!\n/help for commands.`);
  }

  private async _onHelp(ctx: Context): Promise<void> {
    await ctx.reply(
      "🐈 nanobot commands:\n" +
      "/new — New conversation\n" +
      "/stop — Stop current task\n" +
      "/restart — Restart the bot\n" +
      "/status — Show status\n" +
      "/help — Show this help",
    );
  }

  private _senderId(user: User): string {
    return user.username ? `${user.id}|${user.username}` : String(user.id);
  }

  private _deriveTopicSessionKey(message: Message): string | null {
    const threadId = (message as unknown as Record<string, unknown>)["message_thread_id"] as number | undefined;
    if (message.chat.type === "private" || threadId == null) return null;
    return `telegram:${message.chat.id}:topic:${threadId}`;
  }

  private async _isGroupMessageForBot(message: Message): Promise<boolean> {
    if (message.chat.type === "private") return true;
    const policy = (this.config["groupPolicy"] as string | undefined) ?? "mention";
    if (policy === "open") return true;

    const username = this._botUsername;
    if (!username) return false;

    const handle = `@${username}`.toLowerCase();
    const msgAny = message as unknown as Record<string, unknown>;
    const text = (msgAny["text"] as string | undefined) ?? "";
    const caption = (msgAny["caption"] as string | undefined) ?? "";
    if (text.toLowerCase().includes(handle) || caption.toLowerCase().includes(handle)) return true;

    const reply = msgAny["reply_to_message"] as Record<string, unknown> | undefined;
    const replyFrom = reply?.["from"] as User | undefined;
    return Boolean(this._botUserId && replyFrom && replyFrom.id === this._botUserId);
  }

  private async _forwardCommand(ctx: Context): Promise<void> {
    const user = ctx.from;
    const message = ctx.message;
    if (!user || !message) return;
    const sessionKey = this._deriveTopicSessionKey(message);
    await this._handleMessage({
      senderId: this._senderId(user),
      chatId: String(message.chat.id),
      content: (message as unknown as Record<string, unknown>)["text"] as string ?? "",
      metadata: { message_id: message.message_id },
      ...(sessionKey != null ? { sessionKeyOverride: sessionKey } : {}),
    });
  }

  private async _onMessage(ctx: Context): Promise<void> {
    const user = ctx.from;
    const message = ctx.message;
    if (!user || !message) return;
    if (!await this._isGroupMessageForBot(message)) return;

    const senderId = this._senderId(user);
    const chatId = String(message.chat.id);
    const contentParts: string[] = [];

    const msgAny = message as unknown as Record<string, unknown>;
    const text = msgAny["text"] as string | undefined;
    const caption = msgAny["caption"] as string | undefined;
    if (text) contentParts.push(text);
    if (caption && !text) contentParts.push(caption);

    const content = contentParts.join("\n") || "[empty message]";
    const metadata: Record<string, unknown> = {
      message_id: message.message_id,
      user_id: user.id,
      username: user.username,
      first_name: user.first_name,
      is_group: message.chat.type !== "private",
      message_thread_id: msgAny["message_thread_id"],
    };

    // Typing indicator
    this._startTyping(chatId);

    // Add reaction (best effort)
    const reactEmoji = (this.config["reactEmoji"] as string | undefined) ?? "👀";
    if (reactEmoji) {
      this._bot?.api.setMessageReaction(parseInt(chatId, 10), message.message_id, [
        { type: "emoji", emoji: reactEmoji as never },
      ]).catch(() => { /* ignore */ });
    }

    const sessionKey = this._deriveTopicSessionKey(message);
    await this._handleMessage({
      senderId,
      chatId,
      content,
      metadata,
      ...(sessionKey != null ? { sessionKeyOverride: sessionKey } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Typing indicator
  // ---------------------------------------------------------------------------

  private _startTyping(chatId: string): void {
    this._stopTyping(chatId);
    const intId = parseInt(chatId, 10);
    if (isNaN(intId) || !this._bot) return;
    const sendTyping = () => {
      this._bot?.api.sendChatAction(intId, "typing").catch(() => { /* ignore */ });
    };
    sendTyping();
    this._typingTimers.set(chatId, setInterval(sendTyping, 4000));
  }

  private _stopTyping(chatId: string): void {
    const timer = this._typingTimers.get(chatId);
    if (timer) { clearInterval(timer); this._typingTimers.delete(chatId); }
  }
}
