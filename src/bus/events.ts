/**
 * Event types for the message bus.
 * Mirrors nanobot/bus/events.py
 */

export interface InboundMessage {
  /** Source channel: telegram, discord, slack, cli, system, etc. */
  channel: string;
  /** User or sender identifier. */
  senderId: string;
  /** Chat/channel identifier within the source. */
  chatId: string;
  /** Text content. */
  content: string;
  /** ISO timestamp (default: now). */
  timestamp?: string;
  /** Media file paths / URLs attached to the message. */
  media?: string[];
  /** Channel-specific extra data. */
  metadata?: Record<string, unknown>;
  /**
   * Optional override that pins this message to a specific session key
   * (e.g. thread-scoped sessions in Slack).
   */
  sessionKeyOverride?: string | null;
}

/** Derived session key: override or "{channel}:{chatId}". */
export function sessionKey(msg: InboundMessage): string {
  return msg.sessionKeyOverride ?? `${msg.channel}:${msg.chatId}`;
}

export interface OutboundMessage {
  channel: string;
  chatId: string;
  content: string;
  replyTo?: string | null;
  media?: string[];
  metadata?: Record<string, unknown>;
}
