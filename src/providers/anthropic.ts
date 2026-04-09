/**
 * Anthropic provider — native SDK integration for Claude models.
 * Mirrors nanobot/providers/anthropic_provider.py
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import type { ChatOptions, ChatStreamOptions, LLMResponse, ToolCallRequest } from "./base.js";
import { LLMProvider, sanitizeEmptyContent } from "./base.js";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const IDLE_TIMEOUT_MS = parseInt(process.env["NANOBOT_STREAM_IDLE_TIMEOUT_S"] ?? "90") * 1000;

function genToolId(): string {
  const bytes = randomBytes(22);
  return "toolu_" + Array.from(bytes, (b) => ALNUM[b % ALNUM.length]).join("");
}

// ---------------------------------------------------------------------------
// Message conversion helpers
// ---------------------------------------------------------------------------

type AnthropicMessage = Record<string, unknown>;

function toolResultBlock(msg: Record<string, unknown>): Record<string, unknown> {
  const content = msg["content"];
  return {
    type: "tool_result",
    tool_use_id: msg["tool_call_id"] ?? "",
    content: typeof content === "string" || Array.isArray(content)
      ? content
      : content != null ? String(content) : "",
  };
}

function assistantBlocks(msg: Record<string, unknown>): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const content = msg["content"];

  for (const tb of (msg["thinking_blocks"] as Record<string, unknown>[] | undefined) ?? []) {
    if (tb["type"] === "thinking") {
      blocks.push({ type: "thinking", thinking: tb["thinking"] ?? "", signature: tb["signature"] ?? "" });
    }
  }

  if (typeof content === "string" && content) {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      blocks.push(typeof item === "object" && item !== null ? item as Record<string, unknown> : { type: "text", text: String(item) });
    }
  }

  for (const tc of (msg["tool_calls"] as Record<string, unknown>[] | undefined) ?? []) {
    if (typeof tc !== "object" || tc === null) continue;
    const fn = (tc["function"] as Record<string, unknown>) ?? {};
    let args = fn["arguments"] ?? "{}";
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    blocks.push({
      type: "tool_use",
      id: tc["id"] ?? genToolId(),
      name: fn["name"] ?? "",
      input: typeof args === "object" && args !== null ? args : {},
    });
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function convertUserContent(content: unknown): unknown {
  if (typeof content === "string" || content == null) return content || "(empty)";
  if (!Array.isArray(content)) return String(content);

  const result: Record<string, unknown>[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) {
      result.push({ type: "text", text: String(item) });
      continue;
    }
    const block = item as Record<string, unknown>;
    if (block["type"] === "image_url") {
      const converted = convertImageBlock(block);
      if (converted) result.push(converted);
      continue;
    }
    result.push(block);
  }
  return result.length > 0 ? result : "(empty)";
}

function convertImageBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  const url = ((block["image_url"] as Record<string, unknown> | undefined)?.["url"] as string) ?? "";
  if (!url) return null;
  const m = url.match(/^data:(image\/\w+);base64,(.+)$/s);
  if (m) {
    return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  }
  return { type: "image", source: { type: "url", url } };
}

function mergeConsecutive(msgs: AnthropicMessage[]): AnthropicMessage[] {
  if (msgs.length === 0) return msgs;
  const merged: AnthropicMessage[] = [msgs[0]!];
  for (let i = 1; i < msgs.length; i++) {
    const msg = msgs[i]!;
    const prev = merged[merged.length - 1]!;
    if (prev["role"] === msg["role"]) {
      // Only copy when we actually need to merge
      let prevC = prev["content"];
      let curC = msg["content"];
      if (typeof prevC === "string") prevC = [{ type: "text", text: prevC }];
      if (typeof curC === "string") curC = [{ type: "text", text: curC }];
      if (Array.isArray(prevC) && Array.isArray(curC)) {
        prev["content"] = [...prevC, ...curC];
      }
    } else {
      merged.push(msg); // direct reference — no spread
    }
  }
  return merged;
}

function convertMessages(
  messages: Record<string, unknown>[],
): { system: string | Record<string, unknown>[]; msgs: AnthropicMessage[] } {
  let system: string | Record<string, unknown>[] = "";
  const raw: AnthropicMessage[] = [];

  for (const msg of messages) {
    const role = msg["role"] as string;
    const content = msg["content"];

    if (role === "system") {
      system = (typeof content === "string" || Array.isArray(content))
        ? (content as string | Record<string, unknown>[])
        : String(content ?? "");
      continue;
    }

    if (role === "tool") {
      const block = toolResultBlock(msg);
      if (raw.length > 0 && raw[raw.length - 1]!["role"] === "user") {
        const prev = raw[raw.length - 1]!;
        const prevC = prev["content"];
        if (Array.isArray(prevC)) {
          prevC.push(block);
        } else {
          prev["content"] = [{ type: "text", text: prevC ?? "" }, block];
        }
      } else {
        raw.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (role === "assistant") {
      raw.push({ role: "assistant", content: assistantBlocks(msg) });
      continue;
    }

    if (role === "user") {
      raw.push({ role: "user", content: convertUserContent(content) });
      continue;
    }
  }

  return { system, msgs: mergeConsecutive(raw) };
}

function convertTools(tools: Record<string, unknown>[] | null | undefined): Record<string, unknown>[] | null {
  if (!tools || tools.length === 0) return null;
  return tools.map((tool) => {
    const fn = (tool["function"] as Record<string, unknown> | undefined) ?? tool;
    const entry: Record<string, unknown> = {
      name: fn["name"] ?? "",
      input_schema: fn["parameters"] ?? { type: "object", properties: {} },
    };
    if (fn["description"]) entry["description"] = fn["description"];
    if (tool["cache_control"]) entry["cache_control"] = tool["cache_control"];
    return entry;
  });
}

function convertToolChoice(
  toolChoice: string | Record<string, unknown> | null | undefined,
  thinkingEnabled: boolean,
): Record<string, unknown> | null {
  if (thinkingEnabled) return { type: "auto" };
  if (toolChoice == null || toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "none") return null;
  if (typeof toolChoice === "object") {
    const name = (toolChoice["function"] as Record<string, unknown> | undefined)?.["name"];
    if (name) return { type: "tool", name };
  }
  return { type: "auto" };
}

function applyCacheControl(
  system: string | Record<string, unknown>[],
  messages: AnthropicMessage[],
  tools: Record<string, unknown>[] | null,
): {
  system: string | Record<string, unknown>[];
  msgs: AnthropicMessage[];
  tools: Record<string, unknown>[] | null;
} {
  const marker = { type: "ephemeral" };

  // Mark system — only copy if actually adding cache_control
  let newSystem = system;
  if (typeof system === "string" && system) {
    newSystem = [{ type: "text", text: system, cache_control: marker }];
  } else if (Array.isArray(system) && system.length > 0) {
    const lastIdx = system.length - 1;
    const patched = { ...(system[lastIdx] as Record<string, unknown>), cache_control: marker };
    newSystem = system.length === 1 ? [patched] : [...system.slice(0, lastIdx), patched];
  }

  // Mark message[-2] — only copy the modified slot, not the full array
  let newMsgs = messages;
  if (messages.length >= 3) {
    const idx = messages.length - 2;
    const m = messages[idx]!;
    const c = m["content"];
    let patched: AnthropicMessage | null = null;
    if (typeof c === "string") {
      patched = { ...m, content: [{ type: "text", text: c, cache_control: marker }] };
    } else if (Array.isArray(c) && c.length > 0) {
      const lastBlock = { ...(c[c.length - 1] as Record<string, unknown>), cache_control: marker };
      patched = { ...m, content: c.length === 1 ? [lastBlock] : [...c.slice(0, -1), lastBlock] };
    }
    if (patched) {
      newMsgs = messages.slice(); // shallow copy only when needed
      newMsgs[idx] = patched;
    }
  }

  // Mark last tool — only copy if tools exist
  let newTools = tools;
  if (tools && tools.length > 0) {
    const patched = { ...tools[tools.length - 1]!, cache_control: marker };
    newTools = tools.length === 1 ? [patched] : [...tools.slice(0, -1), patched];
  }

  return { system: newSystem, msgs: newMsgs, tools: newTools };
}

function parseResponse(response: Anthropic.Message): LLMResponse {
  const contentParts: string[] = [];
  const toolCalls: ToolCallRequest[] = [];
  const thinkingBlocks: Record<string, unknown>[] = [];

  for (const block of response.content as unknown as Record<string, unknown>[]) {
    if (block["type"] === "text") {
      contentParts.push(block["text"] as string);
    } else if (block["type"] === "tool_use") {
      toolCalls.push({
        id: block["id"] as string,
        name: block["name"] as string,
        arguments: typeof block["input"] === "object" && block["input"] !== null
          ? block["input"] as Record<string, unknown>
          : {},
      });
    } else if (block["type"] === "thinking") {
      thinkingBlocks.push({
        type: "thinking",
        thinking: block["thinking"] ?? "",
        signature: block["signature"] ?? "",
      });
    }
  }

  const stopMap: Record<string, string> = {
    tool_use: "tool_calls",
    end_turn: "stop",
    max_tokens: "length",
  };
  const finishReason = stopMap[response.stop_reason ?? ""] ?? response.stop_reason ?? "stop";

  const usage: Record<string, number> = {};
  if (response.usage) {
    const u = response.usage as unknown as Record<string, number>;
    const inputTokens = u["input_tokens"] ?? 0;
    const cacheCreate = u["cache_creation_input_tokens"] ?? 0;
    const cacheRead = u["cache_read_input_tokens"] ?? 0;
    const totalPrompt = inputTokens + cacheCreate + cacheRead;
    const outputTokens = u["output_tokens"] ?? 0;
    usage["prompt_tokens"] = totalPrompt;
    usage["completion_tokens"] = outputTokens;
    usage["total_tokens"] = totalPrompt + outputTokens;
    if (cacheCreate) usage["cache_creation_input_tokens"] = cacheCreate;
    if (cacheRead) {
      usage["cache_read_input_tokens"] = cacheRead;
      usage["cached_tokens"] = cacheRead;
    }
  }

  return {
    content: contentParts.join("") || null,
    toolCalls,
    finishReason,
    usage,
    thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : null,
  };
}

// ---------------------------------------------------------------------------
// Provider class
// ---------------------------------------------------------------------------

export class AnthropicProvider extends LLMProvider {
  private readonly client: Anthropic;
  private readonly defaultModel: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: {
    apiKey?: string | null;
    apiBase?: string | null;
    defaultModel?: string;
    extraHeaders?: Record<string, string> | null;
  } = {}) {
    super(opts.apiKey, opts.apiBase);
    this.defaultModel = opts.defaultModel ?? "claude-sonnet-4-20250514";
    this.extraHeaders = opts.extraHeaders ?? {};

    const clientOpts: ConstructorParameters<typeof Anthropic>[0] = {};
    if (opts.apiKey) clientOpts.apiKey = opts.apiKey;
    if (opts.apiBase) clientOpts.baseURL = opts.apiBase;
    if (Object.keys(this.extraHeaders).length > 0) clientOpts.defaultHeaders = this.extraHeaders;
    this.client = new Anthropic(clientOpts);
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  private static stripPrefix(model: string): string {
    return model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
  }

  private buildKwargs(opts: ChatOptions) {
    const modelName = AnthropicProvider.stripPrefix(opts.model ?? this.defaultModel);
    const sanitized = sanitizeEmptyContent(opts.messages);
    const { system, msgs } = convertMessages(sanitized);
    let anthropicTools = convertTools(opts.tools ?? null);

    const thinkingEnabled = Boolean(opts.reasoningEffort);
    const cached = applyCacheControl(system, msgs, anthropicTools);
    const finalSystem = cached.system;
    const finalMsgs = cached.msgs;
    anthropicTools = cached.tools;

    const maxTokens = Math.max(1, opts.maxTokens ?? this.generation.maxTokens);
    const kwargs: Record<string, unknown> = {
      model: modelName,
      messages: finalMsgs,
      max_tokens: maxTokens,
    };

    if (finalSystem) kwargs["system"] = finalSystem;

    if (thinkingEnabled) {
      const effort = (opts.reasoningEffort ?? "medium").toLowerCase();
      const budgetMap: Record<string, number> = { low: 1024, medium: 4096, high: Math.max(8192, maxTokens) };
      const budget = budgetMap[effort] ?? 4096;
      kwargs["thinking"] = { type: "enabled", budget_tokens: budget };
      kwargs["max_tokens"] = Math.max(maxTokens, budget + 4096);
      kwargs["temperature"] = 1.0;
    } else {
      kwargs["temperature"] = opts.temperature ?? this.generation.temperature;
    }

    if (anthropicTools && anthropicTools.length > 0) {
      kwargs["tools"] = anthropicTools;
      const tc = convertToolChoice(opts.toolChoice, thinkingEnabled);
      if (tc) kwargs["tool_choice"] = tc;
    }

    if (Object.keys(this.extraHeaders).length > 0) {
      kwargs["extra_headers"] = this.extraHeaders;
    }

    return kwargs;
  }

  override async chat(opts: ChatOptions): Promise<LLMResponse> {
    try {
      const kwargs = this.buildKwargs(opts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await this.client.messages.create(kwargs as any);
      return parseResponse(response as Anthropic.Message);
    } catch (err) {
      return { content: `Error calling LLM: ${err}`, toolCalls: [], finishReason: "error", usage: {} };
    }
  }

  override async chatStream(opts: ChatStreamOptions): Promise<LLMResponse> {
    try {
      const kwargs = this.buildKwargs(opts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = this.client.messages.stream(kwargs as any);

      if (opts.onContentDelta) {
        const textStream = stream.toReadableStream();
        const reader = textStream.getReader();
        // Stream text deltas
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta" &&
            opts.onContentDelta
          ) {
            await opts.onContentDelta(event.delta.text);
          }
        }
        reader.cancel();
      }

      const response = await stream.finalMessage();
      return parseResponse(response);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("stalled") || msg.includes("timeout")) {
        return {
          content: `Error calling LLM: stream stalled for more than ${IDLE_TIMEOUT_MS / 1000} seconds`,
          toolCalls: [],
          finishReason: "error",
          usage: {},
        };
      }
      return { content: `Error calling LLM: ${err}`, toolCalls: [], finishReason: "error", usage: {} };
    }
  }
}
