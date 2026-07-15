import { buildMessages } from "./context.js";
import { recordTurnUsage } from "./usage.js";
import { logger } from "../utils/logger.js";
import { sessionKey as deriveSessionKey } from "../bus/events.js";
import type { InboundMessage } from "../bus/events.js";
import type { MessageBus } from "../bus/queue.js";
import type { AgentRunner, AgentRunSpec } from "./runner.js";
import type { SessionManager } from "../session/manager.js";
import type { CronTool } from "./tools/cron.js";
import type { CronJob } from "../cron/types.js";
import type { MemoryConsolidator } from "./memory.js";

export interface AgentLoopOpts {
  bus: MessageBus;
  runner: AgentRunner;
  sessions: SessionManager;
  runSpec: Omit<AgentRunSpec, "initialMessages">;
  getSystemPrompt: (key: string) => string;
  timezone?: string | null;
  /** Registered CronTool, so its routing context can be set per turn. */
  cronTool?: CronTool | null;
  /** Memory tools backing service, so the active session is set per turn. */
  memoryService?: { setSessionKey(key: string): void } | null;
  /** Optional memory consolidator run after each turn. */
  consolidator?: MemoryConsolidator | null;
  /** Publish interim progress messages (gated further by channel config). */
  sendProgress?: boolean;
}

interface TurnSpec {
  channel: string;
  chatId: string;
  key: string;
  userMessage: string;
  media?: string[];
  deliver: boolean;
  /** True when this turn originates from a cron job (blocks recursive scheduling). */
  cron?: boolean;
}

/**
 * In group chats, multiple people share one session and one "user" role, so
 * the model can't tell who said what across turns. Channels flag such
 * messages via `metadata.is_group` + `metadata.sender_name`; prefix the
 * stored/sent content so history stays attributable per-speaker.
 */
function withSenderLabel(msg: InboundMessage): string {
  if (!msg.metadata?.["is_group"]) return msg.content;
  const name = msg.metadata["sender_name"];
  if (typeof name !== "string" || !name) return msg.content;
  return `[${name}]: ${msg.content}`;
}

export class AgentLoop {
  private readonly bus: MessageBus;
  private readonly runner: AgentRunner;
  private readonly sessions: SessionManager;
  private readonly runSpec: Omit<AgentRunSpec, "initialMessages">;
  private readonly getSystemPrompt: (key: string) => string;
  private readonly timezone: string | null;
  private readonly cronTool: CronTool | null;
  private readonly memoryService: { setSessionKey(key: string): void } | null;
  private readonly consolidator: MemoryConsolidator | null;
  private readonly sendProgress: boolean;

  private running = false;
  /** Tail of the global turn chain — every turn awaits the previous one. */
  private turnTail: Promise<void> = Promise.resolve();
  private consumeTask: Promise<void> | null = null;

  constructor(opts: AgentLoopOpts) {
    this.bus = opts.bus;
    this.runner = opts.runner;
    this.sessions = opts.sessions;
    this.runSpec = opts.runSpec;
    this.getSystemPrompt = opts.getSystemPrompt;
    this.timezone = opts.timezone ?? null;
    this.cronTool = opts.cronTool ?? null;
    this.memoryService = opts.memoryService ?? null;
    this.consolidator = opts.consolidator ?? null;
    this.sendProgress = opts.sendProgress ?? false;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.consumeTask = this._consume();
  }

  async stop(): Promise<void> {
    this.running = false;
    // Wake the consumer blocked on consumeInbound().
    this.bus.closeInbound();
    if (this.consumeTask) await this.consumeTask.catch(() => {});
    // Drain any in-flight turn.
    await this.turnTail.catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Inbound consumption
  // ---------------------------------------------------------------------------

  private async _consume(): Promise<void> {
    while (this.running) {
      const msg = await this.bus.consumeInbound();
      if (msg === undefined) break; // bus closed → shutdown
      if (!this.running) break;
      // Enqueue behind the global turn mutex; do not block consumption.
      void this._runExclusive(() => this._handleInbound(msg)).catch((err) =>
        logger.error({ err, channel: msg.channel }, "agent loop turn failed"),
      );
    }
  }

  private async _handleInbound(msg: InboundMessage): Promise<void> {
    await this._runTurn({
      channel: msg.channel,
      chatId: msg.chatId,
      key: deriveSessionKey(msg),
      userMessage: withSenderLabel(msg),
      media: msg.media ?? [],
      deliver: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Cron entry point (wired as CronService.onJob)
  // ---------------------------------------------------------------------------

  async handleCronJob(job: CronJob): Promise<string | null> {
    const channel = job.payload.channel ?? "system";
    const chatId = job.payload.to ?? "cron";
    return this._runExclusive(() =>
      this._runTurn({
        channel,
        chatId,
        key: `${channel}:${chatId}`,
        userMessage: job.payload.message,
        deliver: job.payload.deliver,
        cron: true,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Shared turn machinery
  // ---------------------------------------------------------------------------

  private async _runTurn(spec: TurnSpec): Promise<string | null> {
    // Point the memory tools at this session before the model can call them.
    this.memoryService?.setSessionKey(spec.key);

    const session = this.sessions.getOrCreate(spec.key);
    const history = session.getHistory(0);

    const messages = buildMessages({
      history,
      currentMessage: spec.userMessage,
      systemPrompt: this.getSystemPrompt(spec.key),
      media: spec.media ?? null,
      channel: spec.channel,
      chatId: spec.chatId,
      timezone: this.timezone,
    });

    // Route the CronTool at this session before the model can call it.
    if (this.cronTool) {
      this.cronTool.setContext(spec.channel, spec.chatId);
      this.cronTool.setCronContext(Boolean(spec.cron));
    }

    let result;
    try {
      result = await this.runner.run({
        ...this.runSpec,
        initialMessages: messages,
        progressCallback: this.sendProgress
          ? async (m: string) => {
              await this.bus.publishOutbound({
                channel: spec.channel,
                chatId: spec.chatId,
                content: m,
                metadata: { _progress: true },
              });
            }
          : null,
      });
    } finally {
      if (this.cronTool) this.cronTool.setCronContext(false);
    }

    // Persist the exchange.
    session.addMessage("user", spec.userMessage);
    if (result.finalContent) session.addMessage("assistant", result.finalContent);
    recordTurnUsage(session, result.usage, this.runSpec.model);
    await this.sessions.save(session);

    // Best-effort memory consolidation.
    if (this.consolidator) {
      try {
        await this.consolidator.maybeConsolidateByTokens(session);
      } catch (err) {
        logger.warn({ err, key: spec.key }, "memory consolidation failed");
      }
    }

    const text = result.finalContent?.trim() ?? "";
    if (spec.deliver && text) {
      await this.bus.publishOutbound({
        channel: spec.channel,
        chatId: spec.chatId,
        content: text,
      });
    }

    return result.finalContent;
  }

  // ---------------------------------------------------------------------------
  // Global turn mutex (promise-chain)
  // ---------------------------------------------------------------------------

  private _runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.turnTail.then(fn, fn);
    // Keep the tail non-rejecting so one failed turn doesn't poison the chain.
    this.turnTail = run.then(
      () => {},
      () => {},
    );
    return run;
  }
}
