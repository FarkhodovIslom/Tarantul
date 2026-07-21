/**
 * Tests for provider utility functions.
 * Covers sanitizeEmptyContent, sanitizeRequestMessages, stripImageContent.
 */

import { describe, it, expect } from "bun:test";
import {
  sanitizeEmptyContent,
  sanitizeRequestMessages,
  stripImageContent,
  LLMProvider,
} from "../src/providers/base.js";
import type { ChatOptions, LLMResponse } from "../src/providers/base.js";

// ---------------------------------------------------------------------------
// sanitizeEmptyContent
// ---------------------------------------------------------------------------

describe("sanitizeEmptyContent", () => {
  it("passes through non-empty string content unchanged", () => {
    const msgs = [{ role: "user", content: "Hello" }];
    const result = sanitizeEmptyContent(msgs);
    expect(result[0]!["content"]).toBe("Hello");
  });

  it("replaces empty string content with (empty) for user messages", () => {
    const msgs = [{ role: "user", content: "" }];
    const result = sanitizeEmptyContent(msgs);
    expect(result[0]!["content"]).toBe("(empty)");
  });

  it("replaces empty string with null for assistant with tool_calls", () => {
    const msgs = [
      { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
    ];
    const result = sanitizeEmptyContent(msgs);
    expect(result[0]!["content"]).toBeNull();
  });

  it("replaces empty string with (empty) for assistant without tool_calls", () => {
    const msgs = [{ role: "assistant", content: "" }];
    const result = sanitizeEmptyContent(msgs);
    expect(result[0]!["content"]).toBe("(empty)");
  });

  it("removes empty text blocks from array content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "actual content" },
        ],
      },
    ];
    const result = sanitizeEmptyContent(msgs);
    const content = result[0]!["content"] as unknown[];
    expect(content).toHaveLength(1);
    expect((content[0] as Record<string, unknown>)["text"]).toBe("actual content");
  });

  it("removes _meta from blocks in array content", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:..." }, _meta: { path: "/tmp/img.png" } },
        ],
      },
    ];
    const result = sanitizeEmptyContent(msgs);
    const block = (result[0]!["content"] as unknown[])[0] as Record<string, unknown>;
    expect("_meta" in block).toBe(false);
    expect(block["type"]).toBe("image_url");
  });

  it("collapses all-empty array content to (empty) for user", () => {
    const msgs = [
      {
        role: "user",
        content: [{ type: "text", text: "" }],
      },
    ];
    const result = sanitizeEmptyContent(msgs);
    expect(result[0]!["content"]).toBe("(empty)");
  });

  it("collapses all-empty array content to null for assistant with tool_calls", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        tool_calls: [{ id: "c1" }],
      },
    ];
    const result = sanitizeEmptyContent(msgs);
    expect(result[0]!["content"]).toBeNull();
  });

  it("wraps single object content in array", () => {
    const msgs = [
      {
        role: "user",
        content: { type: "text", text: "hi" } as unknown as string,
      },
    ];
    const result = sanitizeEmptyContent(msgs);
    expect(Array.isArray(result[0]!["content"])).toBe(true);
  });

  it("passes through null content unchanged", () => {
    const msgs = [{ role: "assistant", content: null as unknown as string }];
    const result = sanitizeEmptyContent(msgs);
    expect(result[0]!["content"]).toBeNull();
  });

  it("keeps input_text and output_text empty blocks as removed", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "input_text", text: "" },
          { type: "output_text", text: "" },
          { type: "text", text: "real" },
        ],
      },
    ];
    const result = sanitizeEmptyContent(msgs);
    const content = result[0]!["content"] as unknown[];
    expect(content).toHaveLength(1);
    expect((content[0] as Record<string, unknown>)["text"]).toBe("real");
  });
});

// ---------------------------------------------------------------------------
// sanitizeRequestMessages
// ---------------------------------------------------------------------------

describe("sanitizeRequestMessages", () => {
  it("removes extra keys not in allowed set", () => {
    const msgs = [
      {
        role: "user",
        content: "Hello",
        timestamp: "2024-01-01",
        custom_field: "value",
      },
    ];
    const result = sanitizeRequestMessages(msgs);
    expect("timestamp" in result[0]!).toBe(false);
    expect("custom_field" in result[0]!).toBe(false);
    expect(result[0]!["role"]).toBe("user");
    expect(result[0]!["content"]).toBe("Hello");
  });

  it("preserves allowed keys: role, content, tool_calls, tool_call_id, name", () => {
    const tc = [{ id: "c1", type: "function" }];
    const msgs = [
      {
        role: "assistant",
        content: null,
        tool_calls: tc,
        name: "bot",
        extra: "remove",
      },
    ];
    const result = sanitizeRequestMessages(msgs);
    expect(result[0]!["tool_calls"]).toEqual(tc);
    expect(result[0]!["name"]).toBe("bot");
    expect("extra" in result[0]!).toBe(false);
  });

  it("adds null content for assistant messages missing content", () => {
    const msgs = [{ role: "assistant", tool_calls: [{ id: "c1" }] }];
    const result = sanitizeRequestMessages(msgs);
    expect("content" in result[0]!).toBe(true);
    expect(result[0]!["content"]).toBeNull();
  });

  it("does not add null content for non-assistant messages missing content", () => {
    const msgs = [{ role: "user" }];
    const result = sanitizeRequestMessages(msgs);
    expect("content" in result[0]!).toBe(false);
  });

  it("accepts custom allowed keys set", () => {
    const msgs = [{ role: "user", content: "hi", custom: "keep" }];
    const result = sanitizeRequestMessages(msgs, new Set(["role", "content", "custom"]));
    expect(result[0]!["custom"]).toBe("keep");
  });

  it("handles empty messages array", () => {
    expect(sanitizeRequestMessages([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// stripImageContent
// ---------------------------------------------------------------------------

describe("stripImageContent", () => {
  it("returns null when no images present", () => {
    const msgs = [{ role: "user", content: "hello" }];
    expect(stripImageContent(msgs)).toBeNull();
  });

  it("returns null when content is string (no array)", () => {
    const msgs = [{ role: "user", content: "text only" }];
    expect(stripImageContent(msgs)).toBeNull();
  });

  it("replaces image_url blocks with text placeholder", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this:" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ];
    const result = stripImageContent(msgs);
    expect(result).not.toBeNull();
    const content = result![0]!["content"] as unknown[];
    const imageBlock = content[1] as Record<string, unknown>;
    expect(imageBlock["type"]).toBe("text");
    expect(String(imageBlock["text"])).toContain("[image");
  });

  it("uses _meta.path in placeholder when available", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:..." }, _meta: { path: "/tmp/photo.png" } },
        ],
      },
    ];
    const result = stripImageContent(msgs);
    expect(result).not.toBeNull();
    const block = (result![0]!["content"] as unknown[])[0] as Record<string, unknown>;
    expect(String(block["text"])).toContain("/tmp/photo.png");
  });

  it("uses [image omitted] when no _meta.path", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:..." } },
        ],
      },
    ];
    const result = stripImageContent(msgs);
    expect(result).not.toBeNull();
    const block = (result![0]!["content"] as unknown[])[0] as Record<string, unknown>;
    expect(String(block["text"])).toContain("[image omitted]");
  });

  it("preserves non-image blocks unchanged", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "intro" },
          { type: "image_url", image_url: { url: "data:..." } },
          { type: "text", text: "outro" },
        ],
      },
    ];
    const result = stripImageContent(msgs);
    expect(result).not.toBeNull();
    const content = result![0]!["content"] as unknown[];
    expect(content).toHaveLength(3);
    expect((content[0] as Record<string, unknown>)["text"]).toBe("intro");
    expect((content[2] as Record<string, unknown>)["text"]).toBe("outro");
  });

  it("handles messages without array content alongside messages with images", () => {
    const msgs = [
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:..." } }],
      },
    ];
    const result = stripImageContent(msgs);
    expect(result).not.toBeNull();
    expect(result![0]!["content"]).toBe("system prompt"); // unchanged
  });
});

// ---------------------------------------------------------------------------
// LLMProvider.chatWithRetry — abort short-circuit
// ---------------------------------------------------------------------------

class CountingProvider extends LLMProvider {
  calls = 0;
  getDefaultModel(): string {
    return "mock-model";
  }
  async chat(_opts: ChatOptions): Promise<LLMResponse> {
    this.calls++;
    return { content: "hi", toolCalls: [], finishReason: "stop", usage: {} };
  }
}

describe("LLMProvider.chatWithRetry", () => {
  it("returns a cancelled response without calling chat() when the signal is already aborted", async () => {
    const provider = new CountingProvider();
    const controller = new AbortController();
    controller.abort();

    const result = await provider.chatWithRetry({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });

    expect(result.finishReason).toBe("cancelled");
    expect(provider.calls).toBe(0);
  });

  it("calls chat() normally when no signal is passed", async () => {
    const provider = new CountingProvider();
    const result = await provider.chatWithRetry({ messages: [{ role: "user", content: "hi" }] });

    expect(result.finishReason).toBe("stop");
    expect(provider.calls).toBe(1);
  });
});
