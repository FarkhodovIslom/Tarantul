/**
 * Agent lifecycle hooks.
 * Mirrors nanobot/agent/hook.py
 *
 * RAM optimizations vs Python:
 * - AgentHookContext holds only a snapshot of the CURRENT iteration,
 *   not a reference to the full growing messages list.
 * - CompositeHook fan-out with per-hook error isolation.
 */

import type { LLMResponse, ToolCallRequest } from "../providers/base.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Hook context — snapshot for one iteration, no live references to history
// ---------------------------------------------------------------------------

export interface AgentHookContext {
  readonly iteration: number;
  /** Current messages sent to the model (shallow copy, not full history). */
  readonly messages: readonly Record<string, unknown>[];
  response?: LLMResponse;
  usage?: Record<string, number>;
  toolCalls?: ToolCallRequest[];
  toolResults?: unknown[];
  toolEvents?: Record<string, string>[];
  finalContent?: string | null;
  stopReason?: string;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Base hook — all methods are no-ops by default
// ---------------------------------------------------------------------------

export class AgentHook {
  wantsStreaming(): boolean {
    return false;
  }

  async beforeIteration(_ctx: AgentHookContext): Promise<void> {}

  async onStream(_ctx: AgentHookContext, _delta: string): Promise<void> {}

  async onStreamEnd(_ctx: AgentHookContext, _opts: { resuming: boolean }): Promise<void> {}

  async beforeExecuteTools(_ctx: AgentHookContext): Promise<void> {}

  async afterIteration(_ctx: AgentHookContext): Promise<void> {}

  finalizeContent(_ctx: AgentHookContext, content: string | null | undefined): string | null {
    return content ?? null;
  }
}

// ---------------------------------------------------------------------------
// CompositeHook — fan-out with error isolation
// ---------------------------------------------------------------------------

export class CompositeHook extends AgentHook {
  private readonly hooks: AgentHook[];

  constructor(hooks: AgentHook[]) {
    super();
    this.hooks = hooks;
  }

  override wantsStreaming(): boolean {
    return this.hooks.some((h) => h.wantsStreaming());
  }

  override async beforeIteration(ctx: AgentHookContext): Promise<void> {
    for (const h of this.hooks) {
      try { await h.beforeIteration(ctx); } catch (e) {
        logger.error({ err: e, hook: h.constructor.name }, "AgentHook.beforeIteration error");
      }
    }
  }

  override async onStream(ctx: AgentHookContext, delta: string): Promise<void> {
    for (const h of this.hooks) {
      try { await h.onStream(ctx, delta); } catch (e) {
        logger.error({ err: e, hook: h.constructor.name }, "AgentHook.onStream error");
      }
    }
  }

  override async onStreamEnd(ctx: AgentHookContext, opts: { resuming: boolean }): Promise<void> {
    for (const h of this.hooks) {
      try { await h.onStreamEnd(ctx, opts); } catch (e) {
        logger.error({ err: e, hook: h.constructor.name }, "AgentHook.onStreamEnd error");
      }
    }
  }

  override async beforeExecuteTools(ctx: AgentHookContext): Promise<void> {
    for (const h of this.hooks) {
      try { await h.beforeExecuteTools(ctx); } catch (e) {
        logger.error({ err: e, hook: h.constructor.name }, "AgentHook.beforeExecuteTools error");
      }
    }
  }

  override async afterIteration(ctx: AgentHookContext): Promise<void> {
    for (const h of this.hooks) {
      try { await h.afterIteration(ctx); } catch (e) {
        logger.error({ err: e, hook: h.constructor.name }, "AgentHook.afterIteration error");
      }
    }
  }

  override finalizeContent(ctx: AgentHookContext, content: string | null | undefined): string | null {
    let c = content ?? null;
    for (const h of this.hooks) {
      c = h.finalizeContent(ctx, c);
    }
    return c;
  }
}
