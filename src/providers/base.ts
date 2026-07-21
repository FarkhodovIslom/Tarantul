import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  extraContent?: Record<string, unknown> | null;
  providerSpecificFields?: Record<string, unknown> | null;
  functionProviderSpecificFields?: Record<string, unknown> | null;
}

export function toolCallToOpenAI(tc: ToolCallRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: tc.id,
    type: "function",
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
      ...(tc.functionProviderSpecificFields
        ? { provider_specific_fields: tc.functionProviderSpecificFields }
        : {}),
    },
  };
  if (tc.extraContent) payload["extra_content"] = tc.extraContent;
  if (tc.providerSpecificFields) payload["provider_specific_fields"] = tc.providerSpecificFields;
  return payload;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCallRequest[];
  finishReason: string;
  usage: Record<string, number>;
  reasoningContent?: string | null;
  thinkingBlocks?: Record<string, unknown>[] | null;
}

export function hasToolCalls(r: LLMResponse): boolean {
  return r.toolCalls.length > 0;
}

export interface GenerationSettings {
  temperature: number;
  maxTokens: number;
  reasoningEffort: string | null;
}

export const DEFAULT_GENERATION: GenerationSettings = {
  temperature: 0.7,
  maxTokens: 4096,
  reasoningEffort: null,
};

export type ContentDeltaCallback = (delta: string) => Promise<void>;
export type RetryWaitCallback = (message: string) => Promise<void>;

export interface ChatOptions {
  messages: Record<string, unknown>[];
  tools?: Record<string, unknown>[] | null;
  model?: string | null;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string | null;
  toolChoice?: string | Record<string, unknown> | null;
}

export interface ChatStreamOptions extends ChatOptions {
  onContentDelta?: ContentDeltaCallback | null;
}

// ---------------------------------------------------------------------------
// Transient error detection & retry
// ---------------------------------------------------------------------------

const TRANSIENT_ERROR_MARKERS = [
  "429",
  "rate limit",
  "500",
  "502",
  "503",
  "504",
  "overloaded",
  "timeout",
  "timed out",
  "connection",
  "server error",
  "temporarily unavailable",
];

const CHAT_RETRY_DELAYS = [1, 2, 4]; // seconds
const PERSISTENT_MAX_DELAY = 60;
const PERSISTENT_IDENTICAL_ERROR_LIMIT = 10;
const RETRY_HEARTBEAT_CHUNK = 30;

function isTransientError(content: string | null): boolean {
  const err = (content ?? "").toLowerCase();
  return TRANSIENT_ERROR_MARKERS.some((m) => err.includes(m));
}

function extractRetryAfter(content: string | null): number | null {
  const text = (content ?? "").toLowerCase();
  const match = text.match(
    /retry after\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)?/,
  );
  if (!match) return null;
  const value = parseFloat(match[1]!);
  const unit = (match[2] ?? "s").toLowerCase();
  if (unit === "ms" || unit === "milliseconds") return Math.max(0.1, value / 1000);
  if (unit === "m" || unit === "min" || unit === "minutes") return value * 60;
  return value;
}

async function sleep(seconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
}

// ---------------------------------------------------------------------------
// Message sanitization helpers (shared across providers)
// ---------------------------------------------------------------------------

const ALLOWED_MSG_KEYS = new Set(["role", "content", "tool_calls", "tool_call_id", "name"]);

export function sanitizeEmptyContent(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  let result: Record<string, unknown>[] | null = null; // lazy copy

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const content = msg["content"];
    const role = msg["role"];
    let replacement: Record<string, unknown> | null = null;

    if (typeof content === "string" && content === "") {
      replacement = {
        ...msg,
        content:
          role === "assistant" && msg["tool_calls"] ? null : "(empty)",
      };
    } else if (Array.isArray(content)) {
      const newItems: unknown[] = [];
      let changed = false;
      for (const item of content) {
        if (
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item)
        ) {
          const block = item as Record<string, unknown>;
          if (
            ["text", "input_text", "output_text"].includes(block["type"] as string) &&
            !block["text"]
          ) {
            changed = true;
            continue;
          }
          if ("_meta" in block) {
            newItems.push(Object.fromEntries(Object.entries(block).filter(([k]) => k !== "_meta")));
            changed = true;
            continue;
          }
        }
        newItems.push(item);
      }
      if (changed) {
        replacement = {
          ...msg,
          content:
            newItems.length > 0
              ? newItems
              : role === "assistant" && msg["tool_calls"]
                ? null
                : "(empty)",
        };
      }
    } else if (typeof content === "object" && content !== null && !Array.isArray(content)) {
      replacement = { ...msg, content: [content] };
    }

    if (replacement) {
      if (!result) result = messages.slice(); // first copy
      result[i] = replacement;
    }
  }

  return result ?? messages;
}

export function sanitizeRequestMessages(
  messages: Record<string, unknown>[],
  allowedKeys: Set<string> = ALLOWED_MSG_KEYS,
): Record<string, unknown>[] {
  return messages.map((msg) => {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(msg)) {
      if (allowedKeys.has(k)) clean[k] = v;
    }
    if (clean["role"] === "assistant") {
      const c = clean["content"];
      if (c === null || c === "" || !("content" in clean)) {
        delete clean["content"];
      }
    }
    return clean;
  });
}

export function stripImageContent(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] | null {
  let found = false;
  const result = messages.map((msg) => {
    const content = msg["content"];
    if (Array.isArray(content)) {
      const newContent = content.map((b) => {
        if (
          typeof b === "object" &&
          b !== null &&
          (b as Record<string, unknown>)["type"] === "image_url"
        ) {
          found = true;
          const meta = (b as Record<string, unknown>)["_meta"] as
            | Record<string, unknown>
            | undefined;
          const path = (meta?.["path"] as string) ?? "";
          return { type: "text", text: path ? `[image: ${path}]` : "[image omitted]" };
        }
        return b;
      });
      return { ...msg, content: newContent };
    }
    return msg;
  });
  return found ? result : null;
}

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

export abstract class LLMProvider {
  readonly apiKey: string | null;
  readonly apiBase: string | null;
  generation: GenerationSettings = { ...DEFAULT_GENERATION };

  constructor(apiKey?: string | null, apiBase?: string | null) {
    this.apiKey = apiKey ?? null;
    this.apiBase = apiBase ?? null;
  }

  abstract chat(opts: ChatOptions): Promise<LLMResponse>;
  abstract getDefaultModel(): string;

  async chatStream(opts: ChatStreamOptions): Promise<LLMResponse> {
    const response = await this.chat(opts);
    if (opts.onContentDelta && response.content) {
      await opts.onContentDelta(response.content);
    }
    return response;
  }

  private async safeChat(opts: ChatOptions): Promise<LLMResponse> {
    try {
      return await this.chat(opts);
    } catch (err) {
      return {
        content: `Error calling LLM: ${err}`,
        toolCalls: [],
        finishReason: "error",
        usage: {},
      };
    }
  }

  private async safeChatStream(opts: ChatStreamOptions): Promise<LLMResponse> {
    try {
      return await this.chatStream(opts);
    } catch (err) {
      return {
        content: `Error calling LLM: ${err}`,
        toolCalls: [],
        finishReason: "error",
        usage: {},
      };
    }
  }

  async chatWithRetry(
    opts: ChatOptions & {
      retryMode?: "standard" | "persistent";
      onRetryWait?: RetryWaitCallback | null;
    },
  ): Promise<LLMResponse> {
    const { retryMode = "standard", onRetryWait, ...chatOpts } = opts;
    const finalOpts: ChatOptions = {
      maxTokens: this.generation.maxTokens,
      temperature: this.generation.temperature,
      reasoningEffort: this.generation.reasoningEffort,
      ...chatOpts,
    };
    return this._runWithRetry(
      (o) => this.safeChat(o),
      finalOpts,
      opts.messages,
      retryMode,
      onRetryWait ?? null,
    );
  }

  async chatStreamWithRetry(
    opts: ChatStreamOptions & {
      retryMode?: "standard" | "persistent";
      onRetryWait?: RetryWaitCallback | null;
    },
  ): Promise<LLMResponse> {
    const { retryMode = "standard", onRetryWait, ...chatOpts } = opts;
    const finalOpts: ChatStreamOptions = {
      maxTokens: this.generation.maxTokens,
      temperature: this.generation.temperature,
      reasoningEffort: this.generation.reasoningEffort,
      ...chatOpts,
    };
    return this._runWithRetry(
      (o) => this.safeChatStream(o),
      finalOpts,
      opts.messages,
      retryMode,
      onRetryWait ?? null,
    );
  }

  private async _runWithRetry(
    call: (opts: ChatStreamOptions) => Promise<LLMResponse>,
    opts: ChatStreamOptions,
    originalMessages: Record<string, unknown>[],
    retryMode: string,
    onRetryWait: RetryWaitCallback | null,
  ): Promise<LLMResponse> {
    const persistent = retryMode === "persistent";
    const delays = [...CHAT_RETRY_DELAYS];
    let attempt = 0;
    let lastResponse: LLMResponse | null = null;
    let lastErrorKey: string | null = null;
    let identicalErrorCount = 0;

    while (true) {
      attempt++;
      const response = await call(opts);

      if (response.finishReason !== "error") return response;

      lastResponse = response;
      const errorKey = (response.content ?? "").trim().toLowerCase() || null;
      if (errorKey && errorKey === lastErrorKey) {
        identicalErrorCount++;
      } else {
        lastErrorKey = errorKey;
        identicalErrorCount = errorKey ? 1 : 0;
      }

      if (!isTransientError(response.content)) {
        const stripped = stripImageContent(originalMessages);
        if (stripped !== null && stripped !== opts.messages) {
          logger.warn("Non-transient LLM error with image content, retrying without images");
          return call({ ...opts, messages: stripped });
        }
        return response;
      }

      if (persistent && identicalErrorCount >= PERSISTENT_IDENTICAL_ERROR_LIMIT) {
        logger.warn(
          `Stopping persistent retry after ${identicalErrorCount} identical transient errors: ${(response.content ?? "").substring(0, 120).toLowerCase()}`,
        );
        return response;
      }

      if (!persistent && attempt > delays.length) break;

      const baseDelay = delays[Math.min(attempt - 1, delays.length - 1)]!;
      let delay = extractRetryAfter(response.content) ?? baseDelay;
      if (persistent) delay = Math.min(delay, PERSISTENT_MAX_DELAY);

      logger.warn(
        `LLM transient error (attempt ${attempt}${persistent && attempt > delays.length ? "+" : `/${delays.length}`}), retrying in ${Math.round(delay)}s: ${(response.content ?? "").substring(0, 120).toLowerCase()}`,
      );

      await this._sleepWithHeartbeat(delay, attempt, persistent, onRetryWait);
    }

    return lastResponse ?? (await call(opts));
  }

  private async _sleepWithHeartbeat(
    delay: number,
    attempt: number,
    persistent: boolean,
    onRetryWait: RetryWaitCallback | null,
  ): Promise<void> {
    let remaining = Math.max(0, delay);
    while (remaining > 0) {
      if (onRetryWait) {
        const kind = persistent ? "persistent retry" : "retry";
        await onRetryWait(
          `Model request failed, ${kind} in ${Math.max(1, Math.round(remaining))}s (attempt ${attempt}).`,
        );
      }
      const chunk = Math.min(remaining, RETRY_HEARTBEAT_CHUNK);
      await sleep(chunk);
      remaining -= chunk;
    }
  }
}
