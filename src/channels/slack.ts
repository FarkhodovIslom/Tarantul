
import { App as BoltApp, LogLevel, type AllMiddlewareArgs, type SlackEventMiddlewareArgs } from "@slack/bolt";
import { logger } from "../utils/logger.js";
import { BaseChannel } from "./base.js";
import type { MessageBus } from "../bus/queue.js";
import type { OutboundMessage } from "../bus/events.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SlackDmConfig {
  enabled?: boolean;
  /** "open" = anyone; "allowlist" = only slack user IDs in allowFrom */
  policy?: "open" | "allowlist";
  allowFrom?: string[];
}

export interface SlackConfig {
  enabled?: boolean;
  botToken?: string;
  appToken?: string;
  allowFrom?: string[];
  groupPolicy?: "open" | "mention" | "allowlist";
  groupAllowFrom?: string[];
  replyInThread?: boolean;
  reactEmoji?: string;
  doneEmoji?: string;
  dm?: SlackDmConfig;
}

// ---------------------------------------------------------------------------
// Markdown → Slack mrkdwn (lightweight, no external dep)
// ---------------------------------------------------------------------------

function mdToMrkdwn(text: string): string {
  if (!text) return "";

  // Save code blocks (protect from transformation)
  const blocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (m) => {
    blocks.push(m);
    return `\x00B${blocks.length - 1}\x00`;
  });
  text = text.replace(/`([^`]+)`/g, (m) => {
    blocks.push(m);
    return `\x00B${blocks.length - 1}\x00`;
  });

  // Headers → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  text = text.replace(/__(.+?)__/g, "*$1*");

  // Italic _text_
  text = text.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "_$1_");

  // Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/g, "~$1~");

  // Links [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Bullet lists
  text = text.replace(/^[-*]\s+/gm, "• ");

  // Restore code blocks
  blocks.forEach((b, i) => {
    text = text.replace(`\x00B${i}\x00`, b);
  });

  return text;
}

// ---------------------------------------------------------------------------
// SlackChannel
// ---------------------------------------------------------------------------

export class SlackChannel extends BaseChannel {
  static override readonly channelName = "slack";
  static override readonly displayName = "Slack";

  declare readonly config: SlackConfig & Record<string, unknown>;

  private _app: BoltApp | null = null;
  private _botUserId: string | null = null;

  constructor(config: Record<string, unknown>, bus: MessageBus) {
    super(config, bus);
  }

  // ---------------------------------------------------------------------------
  // start / stop
  // ---------------------------------------------------------------------------

  override async start(): Promise<void> {
    const botToken = this.config["botToken"] as string | undefined;
    const appToken = this.config["appToken"] as string | undefined;

    if (!botToken || !appToken) {
      logger.error("Slack botToken/appToken not configured");
      return;
    }

    this._running = true;

    this._app = new BoltApp({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    // Resolve bot user ID for mention filtering
    try {
      const auth = await this._app.client.auth.test();
      this._botUserId = (auth.user_id as string | undefined) ?? null;
      logger.info({ userId: this._botUserId }, "Slack bot connected");
    } catch (e) {
      logger.warn({ err: e }, "Slack auth_test failed");
    }

    // Register event handlers
    this._app.event("message", (args) => this._onMessage(args as never));
    this._app.event("app_mention", (args) => this._onAppMention(args as never));

    logger.info("Starting Slack Socket Mode client…");
    await this._app.start();

    // Block until stopped
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this._running) { clearInterval(check); resolve(); }
      }, 1000);
    });
  }

  override async stop(): Promise<void> {
    this._running = false;
    if (this._app) {
      try { await this._app.stop(); } catch { /* ignore */ }
      this._app = null;
    }
  }

  // ---------------------------------------------------------------------------
  // send
  // ---------------------------------------------------------------------------

  override async send(msg: OutboundMessage): Promise<void> {
    if (!this._app) return;

    const slackMeta = (msg.metadata?.["slack"] as Record<string, unknown> | undefined) ?? {};
    const threadTs = slackMeta["thread_ts"] as string | undefined;
    const channelType = slackMeta["channel_type"] as string | undefined;
    const threadTsParam = threadTs && channelType !== "im" ? threadTs : undefined;

    try {
      if (msg.content || !(msg.media?.length)) {
        await this._app.client.chat.postMessage({
          channel: msg.chatId,
          text: msg.content ? mdToMrkdwn(msg.content) : " ",
          ...(threadTsParam != null ? { thread_ts: threadTsParam } : {}),
        });
      }

      for (const mediaPath of msg.media ?? []) {
        try {
          const uploadArgs: Record<string, unknown> = {
            channel_id: msg.chatId,
            file: Bun.file(mediaPath),
            filename: mediaPath.split("/").pop() ?? "file",
          };
          if (threadTsParam != null) uploadArgs["thread_ts"] = threadTsParam;
          await (this._app.client.files as unknown as { uploadV2(args: unknown): Promise<unknown> })
            .uploadV2(uploadArgs);
        } catch (e) {
          logger.error({ err: e, mediaPath }, "Slack file upload failed");
        }
      }

      // Swap reaction: remove :eyes:, add done emoji
      if (!msg.metadata?.["_progress"]) {
        const event = slackMeta["event"] as Record<string, string> | undefined;
        if (event?.["ts"]) {
          await this._updateReaction(msg.chatId, event["ts"]);
        }
      }
    } catch (e) {
      logger.error({ err: e }, "Slack send failed");
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private async _onAppMention(args: SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs): Promise<void> {
    const { event } = args;
    const ev = event as unknown as Record<string, unknown>;
    const senderId = ev["user"] as string | undefined;
    const chatId = ev["channel"] as string | undefined;
    if (!senderId || !chatId) return;

    const text = this._stripMention((ev["text"] as string) ?? "");
    const threadTs = await this._resolveThreadTs(ev, chatId);
    const sessionKey = threadTs ? `slack:${chatId}:${threadTs}` : null;

    await this._react(chatId, ev["ts"] as string | undefined);
    await this._handleMessage({
      senderId,
      chatId,
      content: text,
      metadata: { slack: { event: ev, thread_ts: threadTs, channel_type: "channel" } },
      ...(sessionKey != null ? { sessionKeyOverride: sessionKey } : {}),
    });
  }

  private async _onMessage(args: SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs): Promise<void> {
    const event = args.event as unknown as Record<string, unknown>;
    const senderId = event["user"] as string | undefined;
    const chatId = event["channel"] as string | undefined;
    const channelType = (event["channel_type"] as string | undefined) ?? "";
    const subtype = event["subtype"] as string | undefined;

    // Ignore bot messages / system subtypes
    if (!senderId || !chatId || subtype) return;
    if (this._botUserId && senderId === this._botUserId) return;

    // In channel mode: if mention is present, app_mention fires too — skip to avoid double
    const text = (event["text"] as string | undefined) ?? "";
    if (channelType !== "im" && this._botUserId && text.includes(`<@${this._botUserId}>`)) return;

    // DM routing
    if (channelType === "im") {
      const dmCfg = (this.config["dm"] as SlackDmConfig | undefined) ?? {};
      if (dmCfg.enabled === false) return;
      if (dmCfg.policy === "allowlist") {
        const list = dmCfg.allowFrom ?? [];
        if (!list.includes(senderId)) return;
      }
    } else {
      // Group / channel: apply group policy
      if (!this._shouldRespondInChannel(channelType, text, chatId)) return;
    }

    const cleaned = this._stripMention(text);
    const threadTs = await this._resolveThreadTs(event, chatId);
    const sessionKey = threadTs && channelType !== "im" ? `slack:${chatId}:${threadTs}` : null;

    await this._react(chatId, event["ts"] as string | undefined);
    await this._handleMessage({
      senderId,
      chatId,
      content: cleaned,
      metadata: { slack: { event, thread_ts: threadTs, channel_type: channelType } },
      ...(sessionKey != null ? { sessionKeyOverride: sessionKey } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _shouldRespondInChannel(channelType: string, text: string, chatId: string): boolean {
    const policy = (this.config["groupPolicy"] as string | undefined) ?? "mention";
    if (policy === "open") return true;
    if (policy === "mention") {
      return Boolean(this._botUserId && text.includes(`<@${this._botUserId}>`));
    }
    if (policy === "allowlist") {
      const list = (this.config["groupAllowFrom"] as string[] | undefined) ?? [];
      return list.includes(chatId);
    }
    return false;
  }

  private _stripMention(text: string): string {
    if (!text || !this._botUserId) return text;
    return text.replace(new RegExp(`<@${this._botUserId}>\\s*`, "g"), "").trim();
  }

  private async _resolveThreadTs(event: Record<string, unknown>, _chatId: string): Promise<string | undefined> {
    let threadTs = event["thread_ts"] as string | undefined;
    if (!threadTs && (this.config["replyInThread"] ?? true)) {
      threadTs = event["ts"] as string | undefined;
    }
    return threadTs;
  }

  private async _react(chatId: string, ts: string | undefined): Promise<void> {
    if (!this._app || !ts) return;
    const emoji = (this.config["reactEmoji"] as string | undefined) ?? "eyes";
    try {
      await this._app.client.reactions.add({ channel: chatId, name: emoji, timestamp: ts });
    } catch { /* ignore */ }
  }

  private async _updateReaction(chatId: string, ts: string): Promise<void> {
    if (!this._app) return;
    const reactEmoji = (this.config["reactEmoji"] as string | undefined) ?? "eyes";
    const doneEmoji = (this.config["doneEmoji"] as string | undefined) ?? "white_check_mark";
    try { await this._app.client.reactions.remove({ channel: chatId, name: reactEmoji, timestamp: ts }); } catch { /* ignore */ }
    if (doneEmoji) {
      try { await this._app.client.reactions.add({ channel: chatId, name: doneEmoji, timestamp: ts }); } catch { /* ignore */ }
    }
  }
}
