import { MessageBuffer } from "./message-buffer.js";
import { AgentHook } from "./hook.js";
import type { AgentHookContext, ToolEvent } from "./hook.js";
import { materializeContent } from "./context.js";
import type { Tool } from "./tools/base.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { LLMProvider, ToolCallRequest } from "../providers/base.js";
import { toolCallToOpenAI, hasToolCalls } from "../providers/base.js";
import { logger } from "../utils/logger.js";
import {
  EMPTY_FINAL_RESPONSE_MESSAGE,
  buildFinalizationRetryMessage,
  buildAssistantMessage,
  ensureNonemptyToolResult,
  repeatedExternalLookupError,
  isBlankText,
} from "../utils/runtime.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS_MESSAGE =
  "I reached the maximum number of tool call iterations ({max_iterations}) " +
  "without completing the task. You can try breaking the task into smaller steps.";
const DEFAULT_ERROR_MESSAGE = "Sorry, I encountered an error calling the AI model.";

// ---------------------------------------------------------------------------
// AgentRunSpec — input configuration
// ---------------------------------------------------------------------------

export interface AgentRunSpec {
  /** Pre-built initial messages (system + first user turn). */
  initialMessages: Record<string, unknown>[];
  tools: ToolRegistry;
  model: string;
  maxIterations: number;
  maxToolResultChars: number;
  temperature?: number | null;
  maxTokens?: number | null;
  reasoningEffort?: string | null;
  hook?: AgentHook | null;
  errorMessage?: string | null;
  maxIterationsMessage?: string | null;
  concurrentTools?: boolean;
  failOnToolError?: boolean;
  contextWindowTokens?: number | null;
  providerRetryMode?: "standard" | "persistent";
  progressCallback?: ((msg: string) => Promise<void>) | null;
  checkpointCallback?: ((payload: Record<string, unknown>) => Promise<void>) | null;
  /** Aborts the run at the next safe boundary (model call in flight, or between iterations). */
  signal?: AbortSignal | null;
}

// ---------------------------------------------------------------------------
// AgentRunResult — output
// ---------------------------------------------------------------------------

export interface AgentRunResult {
  finalContent: string | null;
  /** All messages ever appended (for session persistence). Shallow refs — no clone. */
  messages: readonly Record<string, unknown>[];
  toolsUsed: string[];
  usage: Record<string, number>;
  stopReason: string;
  error: string | null;
  toolEvents: Record<string, string>[];
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

export class AgentRunner {
  constructor(private readonly provider: LLMProvider) {}

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    const hook = spec.hook ?? new AgentHook();

    // -----------------------------------------------------------------------
    // MessageBuffer holds all messages. Zero-copy — no list(initial_messages).
    // -----------------------------------------------------------------------
    const buf = new MessageBuffer();
    buf.appendAll(spec.initialMessages as Record<string, unknown>[]);

    const toolsUsed: string[] = [];
    const usage: Record<string, number> = {};
    const toolEvents: Record<string, string>[] = [];
    const externalLookupCounts = new Map<string, number>();

    let finalContent: string | null = null;
    let stopReason = "completed";
    let error: string | null = null;

    // Tool definitions don't change within a single run() call — estimate
    // their token cost once instead of re-stringifying them every iteration.
    const toolTokens = spec.contextWindowTokens ? estimateToolTokens(spec.tools) : 0;

    for (let iteration = 0; iteration < spec.maxIterations; iteration++) {
      // A stop request between iterations (e.g. right after a tool batch
      // finishes) is honored here; one still in flight is caught below once
      // the model call itself returns the "cancelled" sentinel.
      if (spec.signal?.aborted) {
        stopReason = "cancelled";
        break;
      }

      // -----------------------------------------------------------------------
      // Context governance — in-place mutations, no list copies.
      // -----------------------------------------------------------------------
      try {
        // 1. Truncate oversized tool results in place (mutates buf slots)
        buf.applyToolResultBudget(spec.maxToolResultChars);

        // 2. Shift windowStart to fit context budget (pure index arithmetic)
        if (spec.contextWindowTokens) {
          const maxOut =
            spec.maxTokens ??
            (typeof this.provider.generation?.maxTokens === "number"
              ? this.provider.generation.maxTokens
              : 4096);
          buf.enforceContextBudget(spec.contextWindowTokens, maxOut, toolTokens);
        }
      } catch (err) {
        logger.warn({ err, iteration }, "Context governance failed; using raw buffer");
      }

      // One shallow array allocation per LLM call — elements are references.
      const messagesForModel = materializeView(buf.toProviderView());

      const ctx: AgentHookContext = { iteration, messages: messagesForModel };
      await hook.beforeIteration(ctx);

      // -----------------------------------------------------------------------
      // Model call
      // -----------------------------------------------------------------------
      const response = await this._requestModel(spec, messagesForModel, hook, ctx);
      const rawUsage = normalizeUsage(response.usage);
      ctx.response = response;
      ctx.usage = { ...rawUsage };
      ctx.toolCalls = response.toolCalls.slice();
      accumulateUsage(usage, rawUsage);

      // -----------------------------------------------------------------------
      // Cancelled mid-call — finalize whatever text streamed before the abort
      // (if any) as a normal assistant message instead of discarding it, then
      // stop. Whatever usage the provider reported before the abort is kept
      // (accumulated above) since it reflects real token spend.
      // -----------------------------------------------------------------------
      if (response.finishReason === "cancelled") {
        stopReason = "cancelled";
        const partial = hook.finalizeContent(ctx, response.content);
        if (hook.wantsStreaming()) {
          await hook.onStreamEnd(ctx, { resuming: false });
        }
        if (!isBlankText(partial)) {
          buf.append(
            buildAssistantMessage(partial, {
              ...(response.reasoningContent != null
                ? { reasoningContent: response.reasoningContent }
                : {}),
            }),
          );
          finalContent = partial;
        }
        ctx.finalContent = finalContent;
        ctx.stopReason = stopReason;
        await hook.afterIteration(ctx);
        break;
      }

      // -----------------------------------------------------------------------
      // Tool call branch
      // -----------------------------------------------------------------------
      if (hasToolCalls(response)) {
        if (hook.wantsStreaming()) {
          await hook.onStreamEnd(ctx, { resuming: true });
        }

        const assistantMsg = buildAssistantMessage(response.content ?? null, {
          toolCalls: response.toolCalls.map(toolCallToOpenAI),
          ...(response.reasoningContent != null
            ? { reasoningContent: response.reasoningContent }
            : {}),
          ...(response.thinkingBlocks != null
            ? { thinkingBlocks: response.thinkingBlocks }
            : {}),
        });
        buf.append(assistantMsg);
        toolsUsed.push(...response.toolCalls.map((tc) => tc.name));

        await this._emitCheckpoint(spec, {
          phase: "awaiting_tools",
          iteration,
          model: spec.model,
          assistantMessage: assistantMsg,
          completedToolResults: [],
          pendingToolCalls: response.toolCalls.map(toolCallToOpenAI),
        });

        await hook.beforeExecuteTools(ctx);

        const { results, events, fatalError } = await this._executeTools(
          spec,
          response.toolCalls,
          externalLookupCounts,
          hook,
          ctx,
        );
        toolEvents.push(...events);
        ctx.toolResults = results;
        ctx.toolEvents = events;

        if (fatalError !== null) {
          error = `Error: ${(fatalError as Error).constructor?.name ?? "Error"}: ${fatalError}`;
          finalContent = error;
          stopReason = "tool_error";
          buf.append(buildAssistantMessage(finalContent));
          ctx.finalContent = finalContent;
          ctx.error = error;
          ctx.stopReason = stopReason;
          await hook.afterIteration(ctx);
          break;
        }

        const completedToolResults: Record<string, unknown>[] = [];
        for (let i = 0; i < response.toolCalls.length; i++) {
          const tc = response.toolCalls[i]!;
          const content = this._normalizeToolResult(spec, tc.name, results[i]);
          const toolMsg: Record<string, unknown> = {
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content,
          };
          buf.append(toolMsg);
          completedToolResults.push(toolMsg);
        }

        await this._emitCheckpoint(spec, {
          phase: "tools_completed",
          iteration,
          model: spec.model,
          assistantMessage: assistantMsg,
          completedToolResults,
          pendingToolCalls: [],
        });

        await hook.afterIteration(ctx);
        continue;
      }

      // -----------------------------------------------------------------------
      // No tool calls — finalize
      // -----------------------------------------------------------------------
      let clean = hook.finalizeContent(ctx, response.content);

      if (response.finishReason !== "error" && isBlankText(clean)) {
        logger.warn(
          { iteration },
          "Empty final response; retrying with explicit finalization prompt",
        );
        if (hook.wantsStreaming()) {
          await hook.onStreamEnd(ctx, { resuming: false });
        }
        const retryResp = await this._requestFinalizationRetry(spec, messagesForModel);
        const retryUsage = normalizeUsage(retryResp.usage);
        accumulateUsage(usage, retryUsage);
        mergeUsageInto(rawUsage, retryUsage);
        ctx.response = retryResp;
        ctx.usage = { ...rawUsage };
        ctx.toolCalls = retryResp.toolCalls.slice();
        clean = hook.finalizeContent(ctx, retryResp.content);
      }

      if (hook.wantsStreaming()) {
        await hook.onStreamEnd(ctx, { resuming: false });
      }

      if (response.finishReason === "error") {
        finalContent = clean ?? spec.errorMessage ?? DEFAULT_ERROR_MESSAGE;
        stopReason = "error";
        error = finalContent;
        buf.append(buildAssistantMessage(finalContent));
        ctx.finalContent = finalContent;
        ctx.error = error;
        ctx.stopReason = stopReason;
        await hook.afterIteration(ctx);
        break;
      }

      if (isBlankText(clean)) {
        finalContent = EMPTY_FINAL_RESPONSE_MESSAGE;
        stopReason = "empty_final_response";
        error = finalContent;
        buf.append(buildAssistantMessage(finalContent));
        ctx.finalContent = finalContent;
        ctx.error = error;
        ctx.stopReason = stopReason;
        await hook.afterIteration(ctx);
        break;
      }

      buf.append(
        buildAssistantMessage(clean, {
          ...(response.reasoningContent != null
            ? { reasoningContent: response.reasoningContent }
            : {}),
          ...(response.thinkingBlocks != null
            ? { thinkingBlocks: response.thinkingBlocks }
            : {}),
        }),
      );

      await this._emitCheckpoint(spec, {
        phase: "final_response",
        iteration,
        model: spec.model,
        assistantMessage: buf.last,
        completedToolResults: [],
        pendingToolCalls: [],
      });

      finalContent = clean;
      ctx.finalContent = finalContent;
      ctx.stopReason = stopReason;
      await hook.afterIteration(ctx);
      break; // normal completion
    }

    // Max iterations exceeded
    if (finalContent === null && stopReason === "completed") {
      stopReason = "max_iterations";
      const template = spec.maxIterationsMessage ?? DEFAULT_MAX_ITERATIONS_MESSAGE;
      finalContent = template.replace("{max_iterations}", String(spec.maxIterations));
      buf.append(buildAssistantMessage(finalContent));
    }

    return {
      finalContent,
      messages: buf.allMessages(), // readonly ref, no copy
      toolsUsed,
      usage,
      stopReason,
      error,
      toolEvents,
    };
  }

  // ---------------------------------------------------------------------------
  // Model request helpers
  // ---------------------------------------------------------------------------

  private async _requestModel(
    spec: AgentRunSpec,
    messages: Record<string, unknown>[],
    hook: AgentHook,
    ctx: AgentHookContext,
  ) {
    const baseOpts = {
      messages,
      tools: spec.tools.getDefinitions() as unknown as Record<string, unknown>[],
      model: spec.model,
      retryMode: spec.providerRetryMode ?? "standard",
      onRetryWait: spec.progressCallback ?? null,
      signal: spec.signal ?? null,
      ...(spec.temperature != null ? { temperature: spec.temperature } : {}),
      ...(spec.maxTokens != null ? { maxTokens: spec.maxTokens } : {}),
      ...(spec.reasoningEffort != null ? { reasoningEffort: spec.reasoningEffort } : {}),
    } as const;

    if (hook.wantsStreaming()) {
      return this.provider.chatStreamWithRetry({
        ...baseOpts,
        onContentDelta: async (delta: string) => hook.onStream(ctx, delta),
      });
    }
    return this.provider.chatWithRetry(baseOpts);
  }

  private async _requestFinalizationRetry(
    spec: AgentRunSpec,
    messages: Record<string, unknown>[],
  ) {
    // Build a new array — this is intentional (finalization is rare, one-off).
    const retryMessages = [...messages, buildFinalizationRetryMessage()];
    return this.provider.chatWithRetry({
      messages: retryMessages,
      tools: null,
      model: spec.model,
      retryMode: spec.providerRetryMode ?? "standard",
      signal: spec.signal ?? null,
      ...(spec.temperature != null ? { temperature: spec.temperature } : {}),
      ...(spec.maxTokens != null ? { maxTokens: spec.maxTokens } : {}),
      ...(spec.reasoningEffort != null ? { reasoningEffort: spec.reasoningEffort } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Tool execution
  // ---------------------------------------------------------------------------

  private async _executeTools(
    spec: AgentRunSpec,
    toolCalls: ToolCallRequest[],
    externalLookupCounts: Map<string, number>,
    hook: AgentHook,
    ctx: AgentHookContext,
  ): Promise<{
    results: unknown[];
    events: Record<string, string>[];
    fatalError: unknown | null;
  }> {
    const batches = partitionToolBatches(spec, toolCalls);
    const rawResults: Array<{ result: unknown; event: ToolEvent; error: unknown }> = [];

    for (const batch of batches) {
      if (spec.concurrentTools && batch.length > 1) {
        const settled = await Promise.all(
          batch.map((tc) => this._runTool(spec, tc, externalLookupCounts, hook, ctx)),
        );
        rawResults.push(...settled);
      } else {
        for (const tc of batch) {
          rawResults.push(await this._runTool(spec, tc, externalLookupCounts, hook, ctx));
        }
      }
    }

    const results: unknown[] = [];
    const events: ToolEvent[] = [];
    let fatalError: unknown | null = null;

    for (const { result, event, error } of rawResults) {
      results.push(result);
      events.push(event);
      if (error !== null && fatalError === null) fatalError = error;
    }

    return { results, events: events as unknown as Record<string, string>[], fatalError };
  }

  private async _runTool(
    spec: AgentRunSpec,
    tc: ToolCallRequest,
    externalLookupCounts: Map<string, number>,
    hook: AgentHook,
    ctx: AgentHookContext,
  ): Promise<{ result: unknown; event: ToolEvent; error: unknown }> {
    await hook.onToolStart(ctx, tc);
    const out = await this._runToolInner(spec, tc, externalLookupCounts);
    await hook.onToolEnd(ctx, tc, out.event);
    return out;
  }

  private async _runToolInner(
    spec: AgentRunSpec,
    tc: ToolCallRequest,
    externalLookupCounts: Map<string, number>,
  ): Promise<{ result: unknown; event: ToolEvent; error: unknown }> {
    const HINT = "\n\n[Analyze the error above and try a different approach.]";

    // Check repeated external lookup throttle
    const lookupError = repeatedExternalLookupError(tc.name, tc.arguments, externalLookupCounts);
    if (lookupError) {
      const event: ToolEvent = {
        name: tc.name,
        status: "error",
        detail: "repeated external lookup blocked",
      };
      return {
        result: lookupError + HINT,
        event,
        error: spec.failOnToolError ? new Error(lookupError) : null,
      };
    }

    // prepareCall — validates tool + params before execution
    let prepError: string | null = null;
    let preparedTool: Tool | null = null;
    let preparedParams: Record<string, unknown> = tc.arguments;

    try {
      const prepared = spec.tools.prepareCall(tc.name, tc.arguments);
      if (prepared.error) {
        prepError = prepared.error;
      } else {
        preparedTool = prepared.tool ?? null;
        preparedParams = prepared.params ?? tc.arguments;
      }
    } catch (err) {
      prepError = String(err);
    }

    if (prepError) {
      const event: ToolEvent = {
        name: tc.name,
        status: "error",
        detail: prepError.split(": ").slice(-1)[0]!.substring(0, 120),
      };
      return {
        result: prepError + HINT,
        event,
        error: spec.failOnToolError ? new Error(prepError) : null,
      };
    }

    // Execute
    let rawResult: unknown;
    try {
      if (preparedTool) {
        rawResult = await preparedTool.execute(preparedParams);
      } else {
        rawResult = await spec.tools.execute(tc.name, preparedParams);
      }
    } catch (err) {
      const msg = `Error: ${(err as Error).constructor?.name ?? "Error"}: ${err}`;
      const event: ToolEvent = {
        name: tc.name,
        status: "error",
        detail: String(err).replace(/\n/g, " ").trim().substring(0, 120),
      };
      return {
        result: msg,
        event,
        error: spec.failOnToolError ? err : null,
      };
    }

    // Check for error-prefixed string results
    if (typeof rawResult === "string" && rawResult.startsWith("Error")) {
      const event: ToolEvent = {
        name: tc.name,
        status: "error",
        detail: rawResult.replace(/\n/g, " ").trim().substring(0, 120),
      };
      return {
        result: rawResult + HINT,
        event,
        error: spec.failOnToolError ? new Error(rawResult) : null,
      };
    }

    const detail = rawResult == null ? "(empty)" : String(rawResult).replace(/\n/g, " ").trim();
    const event: ToolEvent = {
      name: tc.name,
      status: "ok",
      detail: detail.length > 120 ? detail.substring(0, 120) + "..." : detail,
    };
    return { result: rawResult, event, error: null };
  }

  // ---------------------------------------------------------------------------
  // Tool result normalization
  // ---------------------------------------------------------------------------

  private _normalizeToolResult(spec: AgentRunSpec, toolName: string, result: unknown): unknown {
    const filled = ensureNonemptyToolResult(toolName, result);
    if (typeof filled === "string" && filled.length > spec.maxToolResultChars) {
      return filled.slice(0, spec.maxToolResultChars) + "\n... (truncated)";
    }
    return filled;
  }

  // ---------------------------------------------------------------------------
  // Checkpoint emission
  // ---------------------------------------------------------------------------

  private async _emitCheckpoint(
    spec: AgentRunSpec,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (spec.checkpointCallback) {
      await spec.checkpointCallback(payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (no allocation if unused)
// ---------------------------------------------------------------------------

function normalizeUsage(usage: Record<string, number> | undefined): Record<string, number> {
  if (!usage) return {};
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(usage)) {
    const n = Number(v);
    if (!Number.isNaN(n)) result[k] = Math.trunc(n);
  }
  return result;
}

function accumulateUsage(target: Record<string, number>, src: Record<string, number>): void {
  for (const [k, v] of Object.entries(src)) {
    target[k] = (target[k] ?? 0) + v;
  }
}

function mergeUsageInto(target: Record<string, number>, src: Record<string, number>): void {
  for (const [k, v] of Object.entries(src)) {
    target[k] = (target[k] ?? 0) + v;
  }
}

function estimateToolTokens(tools: ToolRegistry): number {
  const defs = tools.getDefinitions() as unknown[];
  if (!defs.length) return 0;
  return Math.ceil(JSON.stringify(defs).length / 4);
}

/**
 * Materialize any LazyImageBlocks in a provider view.
 * Operates on a shallow copy array already returned by toProviderView().
 */
function materializeView(msgs: Record<string, unknown>[]): Record<string, unknown>[] {
  for (let i = 0; i < msgs.length; i++) {
    const resolved = materializeContent(msgs[i]!["content"]);
    if (resolved !== msgs[i]!["content"]) {
      // Only clone this one message — not the whole array
      msgs[i] = { ...msgs[i]!, content: resolved };
    }
  }
  return msgs;
}

function partitionToolBatches(
  spec: AgentRunSpec,
  toolCalls: ToolCallRequest[],
): ToolCallRequest[][] {
  if (!spec.concurrentTools) return toolCalls.map((tc) => [tc]);

  const batches: ToolCallRequest[][] = [];
  let current: ToolCallRequest[] = [];

  for (const tc of toolCalls) {
    const tool = spec.tools.get(tc.name);
    const canBatch = tool?.concurrencySafe ?? false;
    if (canBatch) {
      current.push(tc);
    } else {
      if (current.length) batches.push(current);
      current = [];
      batches.push([tc]);
    }
  }
  if (current.length) batches.push(current);
  return batches;
}
