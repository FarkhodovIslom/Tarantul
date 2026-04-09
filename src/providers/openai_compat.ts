/**
 * OpenAI-compatible provider for all non-Anthropic LLM APIs.
 * Mirrors nanobot/providers/openai_compat_provider.py
 */

import OpenAI from "openai";
import { createHash, randomBytes } from "node:crypto";
import type { ChatOptions, ChatStreamOptions, LLMResponse, ToolCallRequest } from "./base.js";
import { LLMProvider, sanitizeEmptyContent, sanitizeRequestMessages } from "./base.js";
import type { ProviderSpec } from "./registry.js";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ALLOWED_MSG_KEYS = new Set(["role", "content", "tool_calls", "tool_call_id", "name"]);

const DEFAULT_OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/HKUDS/nanobot",
  "X-OpenRouter-Title": "nanobot",
  "X-OpenRouter-Categories": "cli-agent,personal-agent",
};

function shortToolId(): string {
  const bytes = randomBytes(9);
  return Array.from(bytes, (b) => ALNUM[b % ALNUM.length]).join("");
}

function normalizeToolCallId(id: unknown): unknown {
  if (typeof id !== "string") return id;
  if (id.length === 9 && /^[a-zA-Z0-9]+$/.test(id)) return id;
  return createHash("sha1").update(id).digest("hex").slice(0, 9);
}

function usesOpenrouterAttribution(spec: ProviderSpec | null, apiBase: string | null): boolean {
  if (spec?.name === "openrouter") return true;
  return Boolean(apiBase && apiBase.toLowerCase().includes("openrouter"));
}

// ---------------------------------------------------------------------------
// Cache control injection
// ---------------------------------------------------------------------------

function markContent(msg: Record<string, unknown>): Record<string, unknown> {
  const marker = { type: "ephemeral" };
  const content = msg["content"];
  if (typeof content === "string") {
    return { ...msg, content: [{ type: "text", text: content, cache_control: marker }] };
  }
  if (Array.isArray(content) && content.length > 0) {
    const nc = [...(content as Record<string, unknown>[])];
    nc[nc.length - 1] = { ...nc[nc.length - 1]!, cache_control: marker };
    return { ...msg, content: nc };
  }
  return msg;
}

function applyCacheControl(
  messages: Record<string, unknown>[],
  tools: Record<string, unknown>[] | null | undefined,
): { messages: Record<string, unknown>[]; tools: Record<string, unknown>[] | null } {
  // Only copy the array when we actually have slots to modify
  const markSystem = messages.length > 0 && messages[0]?.["role"] === "system";
  const markPenultimate = messages.length >= 3;
  let newMessages = messages;
  if (markSystem || markPenultimate) {
    newMessages = messages.slice(); // single shallow copy
    if (markSystem) newMessages[0] = markContent(newMessages[0]!);
    if (markPenultimate) {
      const idx = newMessages.length - 2;
      newMessages[idx] = markContent(newMessages[idx]!);
    }
  }

  let newTools: Record<string, unknown>[] | null = tools ?? null;
  if (tools && tools.length > 0) {
    const patched = { ...tools[tools.length - 1]!, cache_control: { type: "ephemeral" } };
    newTools = tools.length === 1 ? [patched] : [...tools.slice(0, -1), patched];
  }
  return { messages: newMessages, tools: newTools };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function extractTextContent(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "object" && item !== null) {
        const text = (item as Record<string, unknown>)["text"];
        if (typeof text === "string") { parts.push(text); continue; }
      }
      if (typeof item === "string") parts.push(item);
    }
    return parts.join("") || null;
  }
  return String(value);
}

function getNestedInt(obj: unknown, path: string[]): number {
  let current = obj;
  for (const segment of path) {
    if (current == null) return 0;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return 0;
    }
  }
  return current != null ? parseInt(String(current)) || 0 : 0;
}

function extractUsage(response: unknown): Record<string, number> {
  const resp = response as Record<string, unknown>;
  const usageObj = resp?.["usage"];
  if (!usageObj || typeof usageObj !== "object") return {};

  const u = usageObj as Record<string, unknown>;
  const result: Record<string, number> = {
    prompt_tokens: parseInt(String(u["prompt_tokens"] ?? 0)) || 0,
    completion_tokens: parseInt(String(u["completion_tokens"] ?? 0)) || 0,
    total_tokens: parseInt(String(u["total_tokens"] ?? 0)) || 0,
  };

  // Normalize cached_tokens
  const cachedPaths = [
    ["prompt_tokens_details", "cached_tokens"],
    ["cached_tokens"],
    ["prompt_cache_hit_tokens"],
  ];
  for (const path of cachedPaths) {
    const cached = getNestedInt(u, path);
    if (cached) {
      result["cached_tokens"] = cached;
      break;
    }
  }

  return result;
}

function parseToolCalls(rawToolCalls: Record<string, unknown>[]): ToolCallRequest[] {
  return rawToolCalls.map((tc) => {
    const fn = (tc["function"] as Record<string, unknown>) ?? {};
    let args: unknown = fn["arguments"] ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    return {
      id: shortToolId(),
      name: String(fn["name"] ?? ""),
      arguments: typeof args === "object" && args !== null ? args as Record<string, unknown> : {},
    };
  });
}

function parseResponse(response: unknown): LLMResponse {
  const resp = response as Record<string, unknown>;
  const choices = (resp?.["choices"] as Record<string, unknown>[]) ?? [];

  if (choices.length === 0) {
    const content = extractTextContent(resp?.["content"] ?? resp?.["output_text"]);
    if (content !== null) {
      return { content, toolCalls: [], finishReason: String(resp?.["finish_reason"] ?? "stop"), usage: extractUsage(response) };
    }
    return { content: "Error: API returned empty choices.", toolCalls: [], finishReason: "error", usage: {} };
  }

  const choice0 = choices[0]!;
  const msg0 = (choice0["message"] as Record<string, unknown>) ?? {};
  let content = extractTextContent(msg0["content"]);
  let finishReason = String(choice0["finish_reason"] ?? "stop");
  let reasoningContent: string | null = (msg0["reasoning_content"] as string | undefined) ?? null;

  const rawToolCalls: Record<string, unknown>[] = [];
  for (const ch of choices) {
    const m = (ch["message"] as Record<string, unknown>) ?? {};
    const tcs = m["tool_calls"] as Record<string, unknown>[] | undefined;
    if (tcs?.length) {
      rawToolCalls.push(...tcs);
      if (ch["finish_reason"] === "tool_calls" || ch["finish_reason"] === "stop") {
        finishReason = ch["finish_reason"] as string;
      }
    }
    if (!content) content = extractTextContent(m["content"]);
    if (!reasoningContent) reasoningContent = (m["reasoning_content"] as string | undefined) ?? null;
  }

  return {
    content,
    toolCalls: parseToolCalls(rawToolCalls),
    finishReason,
    usage: extractUsage(response),
    reasoningContent,
  };
}

// ---------------------------------------------------------------------------
// Provider class
// ---------------------------------------------------------------------------

export class OpenAICompatProvider extends LLMProvider {
  private readonly client: OpenAI;
  private readonly defaultModel: string;
  private readonly spec: ProviderSpec | null;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: {
    apiKey?: string | null;
    apiBase?: string | null;
    defaultModel?: string;
    extraHeaders?: Record<string, string> | null;
    spec?: ProviderSpec | null;
  } = {}) {
    super(opts.apiKey, opts.apiBase);
    this.defaultModel = opts.defaultModel ?? "gpt-4o";
    this.spec = opts.spec ?? null;
    this.extraHeaders = opts.extraHeaders ?? {};

    if (opts.apiKey && this.spec?.envKey) {
      this.setupEnv(opts.apiKey, opts.apiBase ?? null);
    }

    const effectiveBase = opts.apiBase ?? this.spec?.defaultApiBase ?? undefined;
    const defaultHeaders: Record<string, string> = {
      "x-session-affinity": randomBytes(16).toString("hex"),
    };
    if (usesOpenrouterAttribution(this.spec, effectiveBase ?? null)) {
      Object.assign(defaultHeaders, DEFAULT_OPENROUTER_HEADERS);
    }
    Object.assign(defaultHeaders, this.extraHeaders);

    this.client = new OpenAI({
      apiKey: opts.apiKey ?? "no-key",
      baseURL: effectiveBase,
      defaultHeaders,
    });
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  private setupEnv(apiKey: string, apiBase: string | null): void {
    const spec = this.spec;
    if (!spec?.envKey) return;
    const effectiveBase = apiBase ?? spec.defaultApiBase;
    if (spec.isGateway) {
      process.env[spec.envKey] = apiKey;
    } else {
      process.env[spec.envKey] ??= apiKey;
    }
    for (const [envName, envVal] of spec.envExtras) {
      const resolved = envVal.replace("{api_key}", apiKey).replace("{api_base}", effectiveBase);
      process.env[envName] ??= resolved;
    }
  }

  private sanitizeMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
    const sanitized = sanitizeRequestMessages(messages, ALLOWED_MSG_KEYS);
    const idMap = new Map<string, string>();

    const mapId = (value: unknown): unknown => {
      if (typeof value !== "string") return value;
      if (!idMap.has(value)) {
        idMap.set(value, normalizeToolCallId(value) as string);
      }
      return idMap.get(value);
    };

    for (const clean of sanitized) {
      const tcs = clean["tool_calls"];
      if (Array.isArray(tcs)) {
        clean["tool_calls"] = tcs.map((tc: unknown) => {
          if (typeof tc !== "object" || tc === null) return tc;
          const t = { ...(tc as Record<string, unknown>) };
          t["id"] = mapId(t["id"]);
          return t;
        });
      }
      if (clean["tool_call_id"]) {
        clean["tool_call_id"] = mapId(clean["tool_call_id"]);
      }
    }
    return sanitized;
  }

  private buildKwargs(opts: ChatOptions): Record<string, unknown> {
    let modelName = opts.model ?? this.defaultModel;
    let messages = sanitizeEmptyContent(opts.messages);
    let tools = opts.tools ? [...opts.tools] : null;
    const spec = this.spec;

    if (spec?.supportsPromptCaching && (modelName.toLowerCase().startsWith("anthropic/") || modelName.toLowerCase().startsWith("claude"))) {
      const cached = applyCacheControl(messages, tools);
      messages = cached.messages;
      tools = cached.tools;
    }

    if (spec?.stripModelPrefix) {
      modelName = modelName.split("/").pop()!;
    }

    const kwargs: Record<string, unknown> = {
      model: modelName,
      messages: this.sanitizeMessages(messages),
      temperature: opts.temperature ?? this.generation.temperature,
    };

    if (spec?.supportsMaxCompletionTokens) {
      kwargs["max_completion_tokens"] = Math.max(1, opts.maxTokens ?? this.generation.maxTokens);
    } else {
      kwargs["max_tokens"] = Math.max(1, opts.maxTokens ?? this.generation.maxTokens);
    }

    // Per-model param overrides
    if (spec) {
      const modelLower = modelName.toLowerCase();
      for (const [pattern, overrides] of spec.modelOverrides) {
        if (modelLower.includes(pattern.toLowerCase())) {
          Object.assign(kwargs, overrides);
          break;
        }
      }
    }

    if (opts.reasoningEffort) {
      kwargs["reasoning_effort"] = opts.reasoningEffort;
    }

    if (tools && tools.length > 0) {
      kwargs["tools"] = tools;
      kwargs["tool_choice"] = opts.toolChoice ?? "auto";
    }

    return kwargs;
  }

  override async chat(opts: ChatOptions): Promise<LLMResponse> {
    try {
      const kwargs = this.buildKwargs(opts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await this.client.chat.completions.create(kwargs as any);
      return parseResponse(response);
    } catch (err) {
      return { content: `Error calling LLM: ${err}`, toolCalls: [], finishReason: "error", usage: {} };
    }
  }

  override async chatStream(opts: ChatStreamOptions): Promise<LLMResponse> {
    try {
      const kwargs = this.buildKwargs(opts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream: AsyncIterable<Record<string, unknown>> = await this.client.chat.completions.create({ ...kwargs, stream: true } as any) as any;

      // Accumulate streaming response
      let content = "";
      const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();
      let finishReason = "stop";
      let usage: Record<string, number> = {};
      let reasoningContent = "";

      for await (const chunk of stream) {
        const choices = (chunk["choices"] as Record<string, unknown>[]) ?? [];
        for (const choice of choices) {
          const delta = (choice["delta"] as Record<string, unknown>) ?? {};
          const deltaContent = delta["content"];
          if (typeof deltaContent === "string" && deltaContent) {
            content += deltaContent;
            if (opts.onContentDelta) await opts.onContentDelta(deltaContent);
          }
          const reasoning = delta["reasoning_content"];
          if (typeof reasoning === "string") reasoningContent += reasoning;

          const deltaTcs = delta["tool_calls"] as Record<string, unknown>[] | undefined;
          if (deltaTcs) {
            for (const tc of deltaTcs) {
              const idx = (tc["index"] as number) ?? 0;
              const fn = (tc["function"] as Record<string, unknown>) ?? {};
              if (!toolCallsMap.has(idx)) {
                toolCallsMap.set(idx, { id: String(tc["id"] ?? shortToolId()), name: "", args: "" });
              }
              const entry = toolCallsMap.get(idx)!;
              if (fn["name"]) entry.name += String(fn["name"]);
              if (fn["arguments"]) entry.args += String(fn["arguments"]);
            }
          }
          if (choice["finish_reason"]) finishReason = String(choice["finish_reason"]);
        }
        if (chunk["usage"]) usage = extractUsage(chunk);
      }

      const toolCalls: ToolCallRequest[] = [];
      for (const [, entry] of toolCallsMap) {
        let args: unknown;
        try { args = JSON.parse(entry.args); } catch { args = {}; }
        toolCalls.push({
          id: shortToolId(),
          name: entry.name,
          arguments: typeof args === "object" && args !== null ? args as Record<string, unknown> : {},
        });
      }

      return {
        content: content || null,
        toolCalls,
        finishReason,
        usage,
        reasoningContent: reasoningContent || null,
      };
    } catch (err) {
      return { content: `Error calling LLM: ${err}`, toolCalls: [], finishReason: "error", usage: {} };
    }
  }
}
