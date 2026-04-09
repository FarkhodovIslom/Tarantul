/**
 * Runtime-specific helper functions and constants.
 * Mirrors nanobot/utils/runtime.py
 */

import { logger } from "./logger.js";

const MAX_REPEAT_EXTERNAL_LOOKUPS = 2;

export const EMPTY_FINAL_RESPONSE_MESSAGE =
  "I completed the tool steps but couldn't produce a final answer. " +
  "Please try again or narrow the task.";

export const FINALIZATION_RETRY_PROMPT =
  "You have already finished the tool work. Do not call any more tools. " +
  "Using only the conversation and tool results above, provide the final answer for the user now.";

export function emptyToolResultMessage(toolName: string): string {
  return `(${toolName} completed with no output)`;
}

export function ensureNonemptyToolResult(toolName: string, content: unknown): unknown {
  if (content === null || content === undefined) {
    return emptyToolResultMessage(toolName);
  }
  if (typeof content === "string" && !content.trim()) {
    return emptyToolResultMessage(toolName);
  }
  if (Array.isArray(content)) {
    if (content.length === 0) return emptyToolResultMessage(toolName);
    // Check if all text blocks are empty
    const texts = content
      .filter((b): b is Record<string, unknown> =>
        typeof b === "object" && b !== null && (b as Record<string, unknown>)["type"] === "text",
      )
      .map((b) => String(b["text"] ?? ""));
    if (texts.length > 0 && texts.every((t) => !t.trim())) {
      return emptyToolResultMessage(toolName);
    }
  }
  return content;
}

export function isBlankText(content: string | null | undefined): boolean {
  return content == null || !content.trim();
}

export function buildFinalizationRetryMessage(): Record<string, string> {
  return { role: "user", content: FINALIZATION_RETRY_PROMPT };
}

// ---------------------------------------------------------------------------
// Repeated external lookup throttle
// ---------------------------------------------------------------------------

function externalLookupSignature(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName === "web_fetch") {
    const url = String(args["url"] ?? "").trim();
    if (url) return `web_fetch:${url.toLowerCase()}`;
  }
  if (toolName === "web_search") {
    const query = String(args["query"] ?? args["search_term"] ?? "").trim();
    if (query) return `web_search:${query.toLowerCase()}`;
  }
  return null;
}

export function repeatedExternalLookupError(
  toolName: string,
  args: Record<string, unknown>,
  seenCounts: Map<string, number>,
): string | null {
  const sig = externalLookupSignature(toolName, args);
  if (sig === null) return null;

  const count = (seenCounts.get(sig) ?? 0) + 1;
  seenCounts.set(sig, count);

  if (count <= MAX_REPEAT_EXTERNAL_LOOKUPS) return null;

  logger.warn({ sig, count }, "Blocking repeated external lookup");
  return (
    "Error: repeated external lookup blocked. " +
    "Use the results you already have to answer, or try a meaningfully different source."
  );
}

// ---------------------------------------------------------------------------
// Build assistant message helper
// ---------------------------------------------------------------------------

export function buildAssistantMessage(
  content: string | null,
  opts?: {
    toolCalls?: Record<string, unknown>[];
    reasoningContent?: string | null;
    thinkingBlocks?: Record<string, unknown>[] | null;
  },
): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    role: "assistant",
    content: content ?? null,
  };
  if (opts?.toolCalls?.length) msg["tool_calls"] = opts.toolCalls;
  if (opts?.reasoningContent) msg["reasoning_content"] = opts.reasoningContent;
  if (opts?.thinkingBlocks?.length) msg["thinking_blocks"] = opts.thinkingBlocks;
  return msg;
}
