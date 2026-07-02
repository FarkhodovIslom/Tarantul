
import { logger } from "../utils/logger.js";
import { registerBuiltins } from "./registry.js";
import type { BaseChannel } from "./base.js";
import type { MessageBus } from "../bus/queue.js";
import type { OutboundMessage } from "../bus/events.js";
import type { Config } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEND_RETRY_DELAYS_MS = [1000, 2000, 4000];

// ---------------------------------------------------------------------------
// ChannelManager
// ---------------------------------------------------------------------------

export class ChannelManager {
  private readonly _channels = new Map<string, BaseChannel>();
  private _dispatching = false;

  private constructor(
    private readonly _config: Config,
    private readonly _bus: MessageBus,
  ) {}

  // ---------------------------------------------------------------------------
  // Factory (async because it lazy-loads channel modules)
  // ---------------------------------------------------------------------------

  static async create(config: Config, bus: MessageBus): Promise<ChannelManager> {
    const mgr = new ChannelManager(config, bus);
    await mgr._initChannels();
    return mgr;
  }

  private async _initChannels(): Promise<void> {
    await registerBuiltins();

    const { allChannels } = await import("./registry.js");
    const groqKey = this._config.providers.groq?.apiKey ?? "";

    for (const [name, ChannelCls] of allChannels()) {
      const section = (this._config.channels as Record<string, unknown>)[name];
      if (!section || typeof section !== "object") continue;
      const sectionObj = section as Record<string, unknown>;
      if (!sectionObj["enabled"]) continue;

      try {
        const channel = new ChannelCls(sectionObj, this._bus);
        channel.transcriptionApiKey = groqKey;
        this._channels.set(name, channel);
        logger.info({ channel: name }, "channel enabled");
      } catch (e) {
        logger.warn({ channel: name, err: e }, "channel init failed");
      }
    }

    this._validateAllowFrom();
  }

  private _validateAllowFrom(): void {
    for (const [name, ch] of this._channels) {
      const allowFrom = (ch.config?.["allowFrom"] as string[] | undefined) ?? [];
      if (allowFrom.length === 0) {
        throw new Error(
          `Channel "${name}" has empty allowFrom (denies all). ` +
          `Set ["*"] to allow everyone, or add specific user IDs.`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // start / stop
  // ---------------------------------------------------------------------------

  async startAll(): Promise<void> {
    if (this._channels.size === 0) {
      logger.warn("No channels enabled");
      return;
    }

    this._startDispatch();

    const tasks = [...this._channels.entries()].map(([name, ch]) => {
      logger.info({ channel: name }, "starting channel…");
      return ch.start().catch((e) => logger.error({ channel: name, err: e }, "channel start failed"));
    });

    await Promise.all(tasks);
  }

  async stopAll(): Promise<void> {
    this._dispatching = false;
    // Wake the dispatch loop so it observes _dispatching=false and exits
    // instead of blocking forever on consumeOutbound().
    this._bus.closeOutbound();

    for (const [name, ch] of this._channels) {
      try { await ch.stop(); logger.info({ channel: name }, "channel stopped"); }
      catch (e) { logger.error({ channel: name, err: e }, "channel stop error"); }
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound dispatch loop (async, uses setImmediate-style recursion)
  // ---------------------------------------------------------------------------

  private _startDispatch(): void {
    this._dispatching = true;
    void this._dispatchLoop();
  }

  private async _dispatchLoop(): Promise<void> {
    // Pending buffer for messages deferred during stream coalescing
    const pending: OutboundMessage[] = [];

    while (this._dispatching) {
      let msg: OutboundMessage | undefined;

      if (pending.length > 0) {
        msg = pending.shift();
      } else {
        // Block until a message arrives. A single awaiter is registered per
        // iteration, so no abandoned waiters accumulate. `undefined` means the
        // bus was closed (shutdown) — see MessageBus.closeOutbound().
        msg = await this._bus.consumeOutbound();
        if (msg === undefined) break;
      }

      if (!msg) continue;

      // Filter progress messages
      if (msg.metadata?.["_progress"]) {
        const isToolHint = Boolean(msg.metadata["_tool_hint"]);
        if (isToolHint && !this._config.channels.sendToolHints) continue;
        if (!isToolHint && !this._config.channels.sendProgress) continue;
      }

      // Coalesce streaming deltas
      if (msg.metadata?.["_stream_delta"] && !msg.metadata?.["_stream_end"]) {
        const [merged, extra] = this._coalesceDeltas(msg);
        msg = merged;
        pending.push(...extra);
      }

      const channel = this._channels.get(msg.channel);
      if (!channel) {
        logger.warn({ channel: msg.channel }, "unknown channel");
        continue;
      }

      await this._sendWithRetry(channel, msg);
    }
  }

  private _coalesceDeltas(first: OutboundMessage): [OutboundMessage, OutboundMessage[]] {
    const target = `${first.channel}:${first.chatId}`;
    const chunks: string[] = [first.content];
    const meta = { ...first.metadata };
    const extra: OutboundMessage[] = [];

    // Drain any buffered outbound messages synchronously
    while (true) {
      const next = this._bus.tryConsumeOutbound();
      if (!next) break;

      const sameTarget = `${next.channel}:${next.chatId}` === target;
      const isDelta = Boolean(next.metadata?.["_stream_delta"]);
      const isEnd = Boolean(next.metadata?.["_stream_end"]);

      if (sameTarget && isDelta && !meta["_stream_end"]) {
        chunks.push(next.content);
        if (isEnd) { meta["_stream_end"] = true; break; }
      } else {
        extra.push(next);
        break;
      }
    }

    return [{ ...first, content: chunks.join(""), metadata: meta }, extra];
  }

  private async _sendWithRetry(channel: BaseChannel, msg: OutboundMessage): Promise<void> {
    const maxAttempts = Math.max(this._config.channels.sendMaxRetries ?? 3, 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this._sendOnce(channel, msg);
        return;
      } catch (e) {
        if (attempt === maxAttempts - 1) {
          logger.error({ channel: msg.channel, err: e, attempt: attempt + 1 }, "send failed permanently");
          return;
        }
        const delay = SEND_RETRY_DELAYS_MS[Math.min(attempt, SEND_RETRY_DELAYS_MS.length - 1)]!;
        logger.warn({ channel: msg.channel, err: e, attempt: attempt + 1, delay }, "send failed, retrying");
        await new Promise<void>((r) => setTimeout(r, delay));
      }
    }
  }

  private async _sendOnce(channel: BaseChannel, msg: OutboundMessage): Promise<void> {
    if (msg.metadata?.["_stream_delta"] || msg.metadata?.["_stream_end"]) {
      await channel.sendDelta(msg.chatId, msg.content, msg.metadata as Record<string, unknown>);
    } else if (!msg.metadata?.["_streamed"]) {
      await channel.send(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getChannel(name: string): BaseChannel | undefined {
    return this._channels.get(name);
  }

  getStatus(): Record<string, { enabled: boolean; running: boolean }> {
    const result: Record<string, { enabled: boolean; running: boolean }> = {};
    for (const [name, ch] of this._channels) {
      result[name] = { enabled: true, running: ch.isRunning };
    }
    return result;
  }

  get enabledChannels(): string[] {
    return [...this._channels.keys()];
  }
}
