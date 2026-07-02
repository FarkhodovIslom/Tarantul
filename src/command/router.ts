
import type { InboundMessage, OutboundMessage } from "../bus/events.js";
import type { Session } from "../session/manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Everything a command handler needs to produce a response. */
export interface CommandContext {
  msg: InboundMessage;
  session: Session | null;
  /** Resolved session key. */
  key: string;
  /** Raw text of the message. */
  raw: string;
  /** Text after the command prefix (populated by prefix routes). */
  args: string;
  /** The agent loop instance — typed loosely to avoid circular imports. */
  loop: AgentLoopRef | null;
}

/**
 * Minimal interface the command handlers expect from the agent loop.
 * Keeps command code decoupled from the full AgentLoop implementation.
 */
export interface AgentLoopRef {
  readonly model: string;
  readonly contextWindowTokens: number | null;
  readonly lastUsage: Record<string, number>;
  readonly startTime: number;
  sessions: {
    getOrCreate(key: string): Session;
    save(session: Session): Promise<void>;
    invalidate(key: string): void;
  };
  activeTasks: Map<string, { cancel(): boolean; done: boolean }[]>;
  scheduleBackground(p: Promise<void>): void;
  stop(): void;
}

export type CommandHandler = (ctx: CommandContext) => Promise<OutboundMessage | null>;

// ---------------------------------------------------------------------------
// CommandRouter
// ---------------------------------------------------------------------------

/**
 * Three-tier command dispatch:
 *   1. priority  — checked before acquiring the session lock
 *   2. exact     — matched inside the lock
 *   3. prefix    — longest-prefix-first match
 *   4. intercept — fallback predicates
 */
export class CommandRouter {
  private readonly _priority = new Map<string, CommandHandler>();
  private readonly _exact = new Map<string, CommandHandler>();
  private readonly _prefix: Array<[string, CommandHandler]> = [];
  private readonly _interceptors: CommandHandler[] = [];

  priority(cmd: string, handler: CommandHandler): void {
    this._priority.set(cmd.toLowerCase(), handler);
  }

  exact(cmd: string, handler: CommandHandler): void {
    this._exact.set(cmd.toLowerCase(), handler);
  }

  prefix(pfx: string, handler: CommandHandler): void {
    this._prefix.push([pfx.toLowerCase(), handler]);
    // Longest prefix first
    this._prefix.sort((a, b) => b[0].length - a[0].length);
  }

  intercept(handler: CommandHandler): void {
    this._interceptors.push(handler);
  }

  isPriority(text: string): boolean {
    return this._priority.has(text.trim().toLowerCase());
  }

  async dispatchPriority(ctx: CommandContext): Promise<OutboundMessage | null> {
    const handler = this._priority.get(ctx.raw.toLowerCase());
    return handler ? handler(ctx) : null;
  }

  async dispatch(ctx: CommandContext): Promise<OutboundMessage | null> {
    const cmd = ctx.raw.toLowerCase();

    const exact = this._exact.get(cmd);
    if (exact) return exact(ctx);

    for (const [pfx, handler] of this._prefix) {
      if (cmd.startsWith(pfx)) {
        ctx.args = ctx.raw.slice(pfx.length);
        return handler(ctx);
      }
    }

    for (const interceptor of this._interceptors) {
      const result = await interceptor(ctx);
      if (result !== null) return result;
    }

    return null;
  }
}
