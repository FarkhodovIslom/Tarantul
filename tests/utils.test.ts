/**
 * Tests for utility modules: runtime.ts, tokens.ts
 */

import { describe, it, expect } from "bun:test";
import {
  ensureNonemptyToolResult,
  isBlankText,
  buildFinalizationRetryMessage,
  repeatedExternalLookupError,
  buildAssistantMessage,
  EMPTY_FINAL_RESPONSE_MESSAGE,
  FINALIZATION_RETRY_PROMPT,
  emptyToolResultMessage,
} from "../src/utils/runtime.js";
import { TokenTracker, estimateMessageTokens } from "../src/utils/tokens.js";

// ---------------------------------------------------------------------------
// runtime.ts — emptyToolResultMessage
// ---------------------------------------------------------------------------

describe("emptyToolResultMessage", () => {
  it("returns message containing tool name", () => {
    expect(emptyToolResultMessage("my_tool")).toContain("my_tool");
  });
});

// ---------------------------------------------------------------------------
// runtime.ts — ensureNonemptyToolResult
// ---------------------------------------------------------------------------

describe("ensureNonemptyToolResult", () => {
  it("returns content unchanged when non-empty string", () => {
    expect(ensureNonemptyToolResult("tool", "some output")).toBe("some output");
  });

  it("returns fallback for null", () => {
    expect(ensureNonemptyToolResult("tool", null)).toContain("tool");
  });

  it("returns fallback for undefined", () => {
    expect(ensureNonemptyToolResult("tool", undefined)).toContain("tool");
  });

  it("returns fallback for empty string", () => {
    expect(ensureNonemptyToolResult("tool", "")).toContain("tool");
  });

  it("returns fallback for whitespace-only string", () => {
    expect(ensureNonemptyToolResult("tool", "   \n  ")).toContain("tool");
  });

  it("returns fallback for empty array", () => {
    expect(ensureNonemptyToolResult("tool", [])).toContain("tool");
  });

  it("returns fallback when all text blocks are empty", () => {
    const blocks = [
      { type: "text", text: "" },
      { type: "text", text: "   " },
    ];
    expect(ensureNonemptyToolResult("tool", blocks)).toContain("tool");
  });

  it("returns content when array has non-empty text block", () => {
    const blocks = [{ type: "text", text: "result" }];
    const result = ensureNonemptyToolResult("tool", blocks);
    expect(result).toBe(blocks);
  });

  it("returns content when array has non-text blocks (e.g. image)", () => {
    const blocks = [{ type: "image_url", url: "data:..." }];
    const result = ensureNonemptyToolResult("tool", blocks);
    expect(result).toBe(blocks);
  });

  it("returns number content unchanged", () => {
    expect(ensureNonemptyToolResult("tool", 42)).toBe(42);
  });

  it("returns object content unchanged", () => {
    const obj = { key: "value" };
    expect(ensureNonemptyToolResult("tool", obj)).toBe(obj);
  });
});

// ---------------------------------------------------------------------------
// runtime.ts — isBlankText
// ---------------------------------------------------------------------------

describe("isBlankText", () => {
  it("returns true for null", () => {
    expect(isBlankText(null)).toBe(true);
  });

  it("returns true for undefined", () => {
    expect(isBlankText(undefined)).toBe(true);
  });

  it("returns true for empty string", () => {
    expect(isBlankText("")).toBe(true);
  });

  it("returns true for whitespace-only string", () => {
    expect(isBlankText("   \n\t  ")).toBe(true);
  });

  it("returns false for non-empty string", () => {
    expect(isBlankText("hello")).toBe(false);
  });

  it("returns false for string with only punctuation", () => {
    expect(isBlankText(".")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runtime.ts — buildFinalizationRetryMessage
// ---------------------------------------------------------------------------

describe("buildFinalizationRetryMessage", () => {
  it("returns object with role=user", () => {
    const msg = buildFinalizationRetryMessage();
    expect(msg.role).toBe("user");
  });

  it("content equals FINALIZATION_RETRY_PROMPT", () => {
    const msg = buildFinalizationRetryMessage();
    expect(msg.content).toBe(FINALIZATION_RETRY_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// runtime.ts — repeatedExternalLookupError
// ---------------------------------------------------------------------------

describe("repeatedExternalLookupError", () => {
  it("returns null for non-web tools", () => {
    const counts = new Map<string, number>();
    const result = repeatedExternalLookupError("exec", { command: "ls" }, counts);
    expect(result).toBeNull();
  });

  it("returns null on first web_fetch call", () => {
    const counts = new Map<string, number>();
    expect(repeatedExternalLookupError("web_fetch", { url: "https://example.com" }, counts)).toBeNull();
  });

  it("returns null on second web_fetch call (within limit)", () => {
    const counts = new Map<string, number>();
    repeatedExternalLookupError("web_fetch", { url: "https://example.com" }, counts);
    expect(repeatedExternalLookupError("web_fetch", { url: "https://example.com" }, counts)).toBeNull();
  });

  it("returns error on third web_fetch call (exceeds limit)", () => {
    const counts = new Map<string, number>();
    repeatedExternalLookupError("web_fetch", { url: "https://example.com" }, counts);
    repeatedExternalLookupError("web_fetch", { url: "https://example.com" }, counts);
    const result = repeatedExternalLookupError("web_fetch", { url: "https://example.com" }, counts);
    expect(result).not.toBeNull();
    expect(result).toContain("repeated external lookup blocked");
  });

  it("different URLs are tracked independently", () => {
    const counts = new Map<string, number>();
    repeatedExternalLookupError("web_fetch", { url: "https://a.com" }, counts);
    repeatedExternalLookupError("web_fetch", { url: "https://a.com" }, counts);
    // Third call for a.com → error
    expect(repeatedExternalLookupError("web_fetch", { url: "https://a.com" }, counts)).not.toBeNull();
    // First call for b.com → null
    expect(repeatedExternalLookupError("web_fetch", { url: "https://b.com" }, counts)).toBeNull();
  });

  it("handles web_search with query field", () => {
    const counts = new Map<string, number>();
    repeatedExternalLookupError("web_search", { query: "cats" }, counts);
    repeatedExternalLookupError("web_search", { query: "cats" }, counts);
    const result = repeatedExternalLookupError("web_search", { query: "cats" }, counts);
    expect(result).not.toBeNull();
  });

  it("handles web_search with search_term field", () => {
    const counts = new Map<string, number>();
    repeatedExternalLookupError("web_search", { search_term: "dogs" }, counts);
    repeatedExternalLookupError("web_search", { search_term: "dogs" }, counts);
    const result = repeatedExternalLookupError("web_search", { search_term: "dogs" }, counts);
    expect(result).not.toBeNull();
  });

  it("returns null for web_fetch with no url", () => {
    const counts = new Map<string, number>();
    expect(repeatedExternalLookupError("web_fetch", {}, counts)).toBeNull();
  });

  it("URL matching is case-insensitive", () => {
    const counts = new Map<string, number>();
    repeatedExternalLookupError("web_fetch", { url: "https://EXAMPLE.COM" }, counts);
    repeatedExternalLookupError("web_fetch", { url: "https://example.com" }, counts);
    const result = repeatedExternalLookupError("web_fetch", { url: "https://Example.COM" }, counts);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runtime.ts — buildAssistantMessage
// ---------------------------------------------------------------------------

describe("buildAssistantMessage", () => {
  it("builds basic message with null content", () => {
    const msg = buildAssistantMessage(null);
    expect(msg["role"]).toBe("assistant");
    expect(msg["content"]).toBeNull();
  });

  it("builds message with text content", () => {
    const msg = buildAssistantMessage("Hello world");
    expect(msg["content"]).toBe("Hello world");
  });

  it("does not include tool_calls when empty array", () => {
    const msg = buildAssistantMessage("hi", { toolCalls: [] });
    expect("tool_calls" in msg).toBe(false);
  });

  it("includes tool_calls when provided", () => {
    const tc = [{ id: "call1", type: "function", function: { name: "test", arguments: "{}" } }];
    const msg = buildAssistantMessage(null, { toolCalls: tc });
    expect(msg["tool_calls"]).toEqual(tc);
  });

  it("includes reasoning_content when provided", () => {
    const msg = buildAssistantMessage("answer", { reasoningContent: "my reasoning" });
    expect(msg["reasoning_content"]).toBe("my reasoning");
  });

  it("does not include reasoning_content when empty/null", () => {
    const msg = buildAssistantMessage("answer", { reasoningContent: null });
    expect("reasoning_content" in msg).toBe(false);
  });

  it("includes thinking_blocks when provided", () => {
    const blocks = [{ type: "thinking", thinking: "hmm" }];
    const msg = buildAssistantMessage(null, { thinkingBlocks: blocks });
    expect(msg["thinking_blocks"]).toEqual(blocks);
  });

  it("does not include thinking_blocks when empty", () => {
    const msg = buildAssistantMessage("text", { thinkingBlocks: [] });
    expect("thinking_blocks" in msg).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runtime.ts — constants
// ---------------------------------------------------------------------------

describe("runtime constants", () => {
  it("EMPTY_FINAL_RESPONSE_MESSAGE is non-empty string", () => {
    expect(typeof EMPTY_FINAL_RESPONSE_MESSAGE).toBe("string");
    expect(EMPTY_FINAL_RESPONSE_MESSAGE.length).toBeGreaterThan(0);
  });

  it("FINALIZATION_RETRY_PROMPT is non-empty string", () => {
    expect(typeof FINALIZATION_RETRY_PROMPT).toBe("string");
    expect(FINALIZATION_RETRY_PROMPT.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// tokens.ts — estimateMessageTokens
// ---------------------------------------------------------------------------

describe("estimateMessageTokens", () => {
  it("returns positive number for typical message", () => {
    const n = estimateMessageTokens({ role: "user", content: "Hello, how are you?" });
    expect(n).toBeGreaterThan(0);
  });

  it("longer content uses more tokens", () => {
    const short = estimateMessageTokens({ role: "user", content: "Hi" });
    const long = estimateMessageTokens({ role: "user", content: "Hi ".repeat(50) });
    expect(long).toBeGreaterThan(short);
  });

  it("handles array content", () => {
    const msg = {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    };
    expect(estimateMessageTokens(msg)).toBeGreaterThan(0);
  });

  it("handles message with tool_calls", () => {
    const msg = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"x":1}' } }],
    };
    expect(estimateMessageTokens(msg)).toBeGreaterThan(0);
  });
});
