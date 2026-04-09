/**
 * Abstract base class for all chat channel implementations.
 * Mirrors nanobot/channels/base.py
 */

import { logger } from "../utils/logger.js";
import type { MessageBus } from "../bus/queue.js";
import type { OutboundMessage } from "../bus/events.js";

// ---------------------------------------------------------------------------
// Channel config minimum shape
// ---------------------------------------------------------------------------

export interface BaseChannelConfig {
  enabled?: boolean;
  allowFrom?: string[];
  streaming?: boolean;
}

// ---------------------------------------------------------------------------
// BaseChannel
// ---------------------------------------------------------------------------

export abstract class BaseChannel {
  /** Short identifier — matches the config section key (e.g. "telegram"). */
  static readonly channelName: string = "base";
  /** Human-readable name for logs (e.g. "Telegram"). */
  static readonly displayName: string = "Base";

  protected _running = false;
  /** Set by ChannelManager from config.providers.groq.apiKey */
  transcriptionApiKey = "";

  constructor(
    readonly config: Record<string, unknown>,
    protected readonly bus: MessageBus,
  ) {}

  /** Whether the channel is currently running. */
  get isRunning(): boolean { return this._running; }

  // ---------------------------------------------------------------------------
  // Abstract interface
  // ---------------------------------------------------------------------------

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(msg: OutboundMessage): Promise<void>;

  /**
   * Send a streaming text chunk.
   * Override in subclasses that support live streaming.
   * Raises on delivery failure so ChannelManager can retry.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sendDelta(_chatId: string, _delta: string, _metadata?: Record<string, unknown>): Promise<void> {
    // no-op default — subclasses override to enable streaming
  }

  /** True when config enables streaming AND this subclass overrides sendDelta. */
  get supportsStreaming(): boolean {
    const streaming = (this.config["streaming"] as boolean | undefined) ?? false;
    return Boolean(streaming) && Object.getPrototypeOf(this).sendDelta !== BaseChannel.prototype.sendDelta;
  }

  // ---------------------------------------------------------------------------
  // Access control
  // ---------------------------------------------------------------------------

  isAllowed(senderId: string): boolean {
    const allowFrom = (this.config["allowFrom"] as string[] | undefined) ?? [];
    if (allowFrom.length === 0) {
      const name = (this.constructor as typeof BaseChannel).channelName;
      logger.warn({ channel: name, senderId }, "allow_from is empty — all access denied");
      return false;
    }
    if (allowFrom.includes("*")) return true;
    return allowFrom.includes(String(senderId));
  }

  // ---------------------------------------------------------------------------
  // Inbound dispatch helper
  // ---------------------------------------------------------------------------

  protected async _handleMessage(opts: {
    senderId: string;
    chatId: string;
    content: string;
    media?: string[];
    metadata?: Record<string, unknown>;
    sessionKeyOverride?: string | null;
  }): Promise<void> {
    const { senderId, chatId, content, media, metadata, sessionKeyOverride } = opts;

    if (!this.isAllowed(senderId)) {
      const name = (this.constructor as typeof BaseChannel).channelName;
      logger.warn(
        { channel: name, senderId },
        "Access denied. Add sender to allowFrom in config.",
      );
      return;
    }

    const meta: Record<string, unknown> = { ...(metadata ?? {}) };
    if (this.supportsStreaming) meta["_wants_stream"] = true;

    const channel = (this.constructor as typeof BaseChannel).channelName;

    await this.bus.publishInbound({
      channel,
      senderId: String(senderId),
      chatId: String(chatId),
      content,
      media: media ?? [],
      metadata: meta,
      ...(sessionKeyOverride != null ? { sessionKeyOverride } : {}),
    });
  }
}
