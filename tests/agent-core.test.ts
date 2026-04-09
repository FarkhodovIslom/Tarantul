/**
 * Tests for agent core: TokenTracker, MessageBuffer, AgentRunner.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TokenTracker, estimateMessageTokens, invalidateTokenCache } from "../src/utils/tokens.js";
import { MessageBuffer } from "../src/agent/message-buffer.js";
import { AgentRunner } from "../src/agent/runner.js";
import { AgentHook, CompositeHook } from "../src/agent/hook.js";
import type { AgentHookContext } from "../src/agent/hook.js";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import type { LLMProvider, ChatOptions, LLMResponse } from "../src/providers/base.js";
import { SystemPromptCache, buildMessages } from "../src/agent/context.js";

// ---------------------------------------------------------------------------
// TokenTracker
// ---------------------------------------------------------------------------

describe("TokenTracker", () => {
  it("tracks tokens on push and sums correctly", () => {
    const tracker = new TokenTracker();
    const msg1 = { role: "user", content: "Hello world" };
    const msg2 = { role: "assistant", content: "Hi there" };
    tracker.push(msg1);
    tracker.push(msg2);
    expect(tracker.totalTokens).toBeGreaterThan(0);
    expect(tracker.length).toBe(2);
  });

  it("sumRange returns correct slice", () => {
    const tracker = new TokenTracker();
    const msgs = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ];
    for (const m of msgs) tracker.push(m);
    const rangeAll = tracker.sumRange(0, 3);
    const range01 = tracker.sumRange(0, 2);
    const range12 = tracker.sumRange(1, 3);
    expect(rangeAll).toBe(range01 + tracker.sumRange(2, 3));
    expect(range12).toBeGreaterThan(0);
  });

  it("update recounts tokens after mutation", () => {
    const tracker = new TokenTracker();
    const msg = { role: "user", content: "short" } as Record<string, unknown>;
    tracker.push(msg);
    const before = tracker.totalTokens;
    msg["content"] = "a very long string ".repeat(50);
    tracker.update(0, msg);
    expect(tracker.totalTokens).toBeGreaterThan(before);
  });

  it("estimateMessageTokens is cached (same object reference)", () => {
    const msg = { role: "user", content: "cached content" };
    const t1 = estimateMessageTokens(msg);
    const t2 = estimateMessageTokens(msg);
    expect(t1).toBe(t2);
  });

  it("invalidateTokenCache clears cache", () => {
    const msg = { role: "user", content: "original" } as Record<string, unknown>;
    estimateMessageTokens(msg); // populate cache
    invalidateTokenCache(msg);
    msg["content"] = "completely different and longer content".repeat(10);
    const refreshed = estimateMessageTokens(msg);
    expect(refreshed).toBeGreaterThan(4);
  });
});

// ---------------------------------------------------------------------------
// MessageBuffer
// ---------------------------------------------------------------------------

describe("MessageBuffer", () => {
  let buf: MessageBuffer;

  beforeEach(() => {
    buf = new MessageBuffer();
  });

  it("append and length", () => {
    buf.append({ role: "system", content: "system" });
    buf.append({ role: "user", content: "hello" });
    expect(buf.length).toBe(2);
    expect(buf.windowLength).toBe(2);
  });

  it("toProviderView includes system message always", () => {
    buf.append({ role: "system", content: "system prompt" });
    buf.append({ role: "user", content: "user msg" });
    buf.append({ role: "assistant", content: "assistant msg" });
    const view = buf.toProviderView();
    expect(view[0]!["role"]).toBe("system");
    expect(view.length).toBe(3);
  });

  it("toProviderViewWith appends extra without mutation", () => {
    buf.append({ role: "system", content: "sys" });
    buf.append({ role: "user", content: "q" });
    const extra = { role: "user", content: "extra" };
    const withExtra = buf.toProviderViewWith(extra);
    const without = buf.toProviderView();
    expect(withExtra.length).toBe(without.length + 1);
    expect(withExtra[withExtra.length - 1]).toBe(extra);
    expect(buf.length).toBe(2); // buffer unchanged
  });

  it("last returns most recently appended message", () => {
    buf.append({ role: "user", content: "a" });
    buf.append({ role: "assistant", content: "b" });
    expect(buf.last!["content"]).toBe("b");
  });

  it("allMessages returns all including before window", () => {
    for (let i = 0; i < 5; i++) {
      buf.append({ role: "user", content: `msg ${i}` });
    }
    expect(buf.allMessages().length).toBe(5);
  });

  it("applyToolResultBudget truncates oversized tool results in place", () => {
    const toolMsg = {
      role: "tool",
      tool_call_id: "t1",
      content: "x".repeat(2000),
    };
    buf.append({ role: "system", content: "sys" });
    buf.append(toolMsg);
    const modified = buf.applyToolResultBudget(100);
    expect(modified).toBe(true);
    const view = buf.toProviderView();
    const tool = view.find((m) => m["role"] === "tool")!;
    expect(typeof tool["content"]).toBe("string");
    expect((tool["content"] as string).length).toBeLessThanOrEqual(120); // 100 + truncation suffix
  });

  it("applyToolResultBudget returns false when nothing to truncate", () => {
    buf.append({ role: "user", content: "short" });
    const modified = buf.applyToolResultBudget(10000);
    expect(modified).toBe(false);
  });

  it("enforceContextBudget advances window when over budget", () => {
    buf.append({ role: "system", content: "system prompt" });
    // Add many large messages
    for (let i = 0; i < 20; i++) {
      buf.append({ role: "user", content: `user message number ${i} with some text` });
      buf.append({
        role: "assistant",
        content: `assistant response to message ${i} with content`,
      });
    }
    const before = buf.windowLength;
    // Force a very tight budget (tiny context window)
    buf.enforceContextBudget(500, 256, 0);
    const after = buf.windowLength;
    expect(after).toBeLessThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

/** Mock LLM provider that returns pre-scripted responses. */
class MockProvider implements Partial<LLMProvider> {
  private responses: LLMResponse[];
  private callCount = 0;
  public generation = { temperature: 0.7, maxTokens: 4096, reasoningEffort: null };

  constructor(responses: LLMResponse[]) {
    this.responses = responses;
  }

  getDefaultModel() { return "mock-model"; }

  async chat(_opts: ChatOptions): Promise<LLMResponse> {
    const r = this.responses[this.callCount % this.responses.length]!;
    this.callCount++;
    return r;
  }

  chatWithRetry(opts: ChatOptions) {
    return this.chat(opts);
  }
  chatStreamWithRetry(opts: ChatOptions) {
    return this.chat(opts);
  }
}

function makeRegistry(): ToolRegistry {
  return new ToolRegistry();
}

function makeSpec(
  provider: MockProvider,
  messages: Record<string, unknown>[],
  tools = makeRegistry(),
) {
  return {
    initialMessages: messages,
    tools,
    model: "mock-model",
    maxIterations: 5,
    maxToolResultChars: 4000,
    provider: provider as unknown as LLMProvider,
  };
}

describe("AgentRunner", () => {
  it("returns final content on simple non-tool response", async () => {
    const provider = new MockProvider([
      { content: "Hello from AI", toolCalls: [], finishReason: "stop", usage: {} },
    ]);
    const runner = new AgentRunner(provider as unknown as LLMProvider);
    const result = await runner.run({
      ...makeSpec(provider, [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]),
    });
    expect(result.finalContent).toBe("Hello from AI");
    expect(result.stopReason).toBe("completed");
    expect(result.error).toBeNull();
  });

  it("executes a tool call and returns final response", async () => {
    const { Tool } = await import("../src/agent/tools/base.js");
    class EchoTool extends Tool {
      readonly name = "echo";
      readonly description = "Echoes input";
      readonly parameters = {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      };
      async execute(p: Record<string, unknown>) {
        return `echo: ${p["text"]}`;
      }
    }

    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    const provider = new MockProvider([
      {
        content: "Let me echo that",
        toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hello" } }],
        finishReason: "tool_calls",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      {
        content: "The echo returned: echo: hello",
        toolCalls: [],
        finishReason: "stop",
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      },
    ]);

    const runner = new AgentRunner(provider as unknown as LLMProvider);
    const result = await runner.run({
      initialMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "echo hello" },
      ],
      tools: registry,
      model: "mock-model",
      maxIterations: 5,
      maxToolResultChars: 4000,
    });

    expect(result.finalContent).toBe("The echo returned: echo: hello");
    expect(result.toolsUsed).toContain("echo");
    expect(result.stopReason).toBe("completed");
  });

  it("hits max iterations when tool calls never end", async () => {
    const provider = new MockProvider([
      {
        content: null,
        toolCalls: [{ id: "tc1", name: "unknown_tool", arguments: {} }],
        finishReason: "tool_calls",
        usage: {},
      },
    ]);

    const runner = new AgentRunner(provider as unknown as LLMProvider);
    const result = await runner.run({
      initialMessages: [{ role: "user", content: "do it" }],
      tools: makeRegistry(),
      model: "mock-model",
      maxIterations: 3,
      maxToolResultChars: 4000,
    });

    expect(result.stopReason).toBe("max_iterations");
    expect(result.finalContent).toContain("3");
  });

  it("accumulates usage across iterations", async () => {
    const { Tool } = await import("../src/agent/tools/base.js");
    class NopTool extends Tool {
      readonly name = "nop";
      readonly description = "Does nothing";
      readonly parameters = { type: "object", properties: {} };
      async execute() { return "done"; }
    }
    const registry = new ToolRegistry();
    registry.register(new NopTool());

    const provider = new MockProvider([
      {
        content: null,
        toolCalls: [{ id: "t1", name: "nop", arguments: {} }],
        finishReason: "tool_calls",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      {
        content: "All done",
        toolCalls: [],
        finishReason: "stop",
        usage: { prompt_tokens: 20, completion_tokens: 3 },
      },
    ]);

    const runner = new AgentRunner(provider as unknown as LLMProvider);
    const result = await runner.run({
      initialMessages: [{ role: "user", content: "go" }],
      tools: registry,
      model: "mock-model",
      maxIterations: 5,
      maxToolResultChars: 4000,
    });

    expect(result.usage["prompt_tokens"]).toBe(30);
    expect(result.usage["completion_tokens"]).toBe(8);
  });

  it("respects hook finalizeContent transformation", async () => {
    class UpperHook extends AgentHook {
      override finalizeContent(_ctx: unknown, content: string | null | undefined) {
        return content ? content.toUpperCase() : null;
      }
    }

    const provider = new MockProvider([
      { content: "lower case response", toolCalls: [], finishReason: "stop", usage: {} },
    ]);

    const runner = new AgentRunner(provider as unknown as LLMProvider);
    const result = await runner.run({
      initialMessages: [{ role: "user", content: "hi" }],
      tools: makeRegistry(),
      model: "mock-model",
      maxIterations: 5,
      maxToolResultChars: 4000,
      hook: new UpperHook(),
    });

    expect(result.finalContent).toBe("LOWER CASE RESPONSE");
  });

  it("does not clone initial messages (shallow ref check)", async () => {
    const systemMsg = { role: "system", content: "sys" };
    const userMsg = { role: "user", content: "hi" };
    const initMsgs = [systemMsg, userMsg];

    const provider = new MockProvider([
      { content: "ok", toolCalls: [], finishReason: "stop", usage: {} },
    ]);

    const runner = new AgentRunner(provider as unknown as LLMProvider);
    const result = await runner.run({
      initialMessages: initMsgs,
      tools: makeRegistry(),
      model: "mock-model",
      maxIterations: 5,
      maxToolResultChars: 4000,
    });

    // allMessages() should contain the original objects (not copies)
    const all = result.messages;
    expect(all[0]).toBe(systemMsg);
    expect(all[1]).toBe(userMsg);
  });
});

// ---------------------------------------------------------------------------
// MessageBuffer — snipToFit + findLegalStart
// ---------------------------------------------------------------------------

describe("MessageBuffer — snipToFit / findLegalStart", () => {
  it("snipToFit advances windowStart under tight budget", () => {
    const buf = new MessageBuffer();
    buf.append({ role: "system", content: "system" });
    for (let i = 0; i < 30; i++) {
      buf.append({ role: "user", content: `message ${i} `.repeat(20) });
      buf.append({ role: "assistant", content: `reply ${i} `.repeat(20) });
    }
    const before = buf.windowLength;
    // Snip to a tiny budget
    buf.snipToFit(200, 0);
    expect(buf.windowLength).toBeLessThanOrEqual(before);
  });

  it("snipToFit does not create orphaned tool result (legal boundary)", () => {
    const buf = new MessageBuffer();
    buf.append({ role: "system", content: "sys" });
    // Sequence: assistant with tool_call, then tool result
    buf.append({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "tc1", type: "function", function: { name: "f", arguments: "{}" } }],
    });
    buf.append({ role: "tool", tool_call_id: "tc1", content: "result" });
    buf.append({ role: "assistant", content: "done" });
    buf.append({ role: "user", content: "next" });

    // Force snip to a budget that would trim aggressively
    buf.snipToFit(50, 0);

    // Provider view should never have a tool result without its assistant
    const view = buf.toProviderView();
    const toolMsgs = view.filter((m) => m["role"] === "tool");
    for (const tool of toolMsgs) {
      const tid = tool["tool_call_id"] as string;
      // Find corresponding assistant message with this tool call id
      const hasAssistant = view.some((m) => {
        if (m["role"] !== "assistant") return false;
        const tcs = m["tool_calls"] as Array<Record<string, string>> | undefined;
        return tcs?.some((tc) => tc["id"] === tid) ?? false;
      });
      expect(hasAssistant).toBe(true);
    }
  });

  it("windowLength + totalTokens accessors work", () => {
    const buf = new MessageBuffer();
    buf.append({ role: "user", content: "hello world" });
    buf.append({ role: "assistant", content: "hi" });
    expect(buf.windowLength).toBe(2);
    expect(buf.totalTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// CompositeHook
// ---------------------------------------------------------------------------

describe("CompositeHook", () => {
  function makeCtx(n = 0): AgentHookContext {
    return { iteration: n, messages: [] };
  }

  it("wantsStreaming returns true if any hook wants streaming", () => {
    class StreamingHook extends AgentHook {
      override wantsStreaming() { return true; }
    }
    const composite = new CompositeHook([new AgentHook(), new StreamingHook()]);
    expect(composite.wantsStreaming()).toBe(true);
  });

  it("wantsStreaming returns false when no hook wants streaming", () => {
    const composite = new CompositeHook([new AgentHook(), new AgentHook()]);
    expect(composite.wantsStreaming()).toBe(false);
  });

  it("beforeIteration fans out to all hooks", async () => {
    const calls: string[] = [];
    class TrackHook extends AgentHook {
      constructor(private id: string) { super(); }
      override async beforeIteration(_ctx: AgentHookContext) { calls.push(this.id); }
    }
    const composite = new CompositeHook([new TrackHook("a"), new TrackHook("b")]);
    await composite.beforeIteration(makeCtx());
    expect(calls).toEqual(["a", "b"]);
  });

  it("onStream fans out to all hooks", async () => {
    const deltas: string[] = [];
    class DeltaHook extends AgentHook {
      override async onStream(_ctx: AgentHookContext, delta: string) { deltas.push(delta); }
    }
    const composite = new CompositeHook([new DeltaHook(), new DeltaHook()]);
    await composite.onStream(makeCtx(), "hello");
    expect(deltas).toEqual(["hello", "hello"]);
  });

  it("onStreamEnd fans out to all hooks", async () => {
    const calls: boolean[] = [];
    class EndHook extends AgentHook {
      override async onStreamEnd(_ctx: AgentHookContext, opts: { resuming: boolean }) {
        calls.push(opts.resuming);
      }
    }
    const composite = new CompositeHook([new EndHook(), new EndHook()]);
    await composite.onStreamEnd(makeCtx(), { resuming: true });
    expect(calls).toEqual([true, true]);
  });

  it("beforeExecuteTools fans out to all hooks", async () => {
    let count = 0;
    class CountHook extends AgentHook {
      override async beforeExecuteTools(_ctx: AgentHookContext) { count++; }
    }
    const composite = new CompositeHook([new CountHook(), new CountHook()]);
    await composite.beforeExecuteTools(makeCtx());
    expect(count).toBe(2);
  });

  it("afterIteration fans out to all hooks", async () => {
    let count = 0;
    class CountHook extends AgentHook {
      override async afterIteration(_ctx: AgentHookContext) { count++; }
    }
    const composite = new CompositeHook([new CountHook(), new CountHook()]);
    await composite.afterIteration(makeCtx());
    expect(count).toBe(2);
  });

  it("isolates errors from one hook so others still run", async () => {
    const calls: string[] = [];
    class BadHook extends AgentHook {
      override async beforeIteration(_ctx: AgentHookContext): Promise<void> {
        throw new Error("hook error");
      }
    }
    class GoodHook extends AgentHook {
      override async beforeIteration(_ctx: AgentHookContext) { calls.push("good"); }
    }
    const composite = new CompositeHook([new BadHook(), new GoodHook()]);
    // Should not throw despite BadHook error
    await composite.beforeIteration(makeCtx());
    expect(calls).toContain("good");
  });

  it("finalizeContent chains through hooks in order", () => {
    class AppendHook extends AgentHook {
      constructor(private suffix: string) { super(); }
      override finalizeContent(_ctx: AgentHookContext, content: string | null | undefined) {
        return (content ?? "") + this.suffix;
      }
    }
    const composite = new CompositeHook([new AppendHook("A"), new AppendHook("B")]);
    const result = composite.finalizeContent(makeCtx(), "start");
    expect(result).toBe("startAB");
  });

  it("finalizeContent passes null through when no hooks modify it", () => {
    const composite = new CompositeHook([new AgentHook(), new AgentHook()]);
    expect(composite.finalizeContent(makeCtx(), null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SystemPromptCache
// ---------------------------------------------------------------------------

describe("SystemPromptCache", () => {
  let wsDir: string;

  beforeEach(() => {
    wsDir = join(tmpdir(), `nanobot-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(wsDir, { recursive: true });
  });

  it("builds a non-empty system prompt", () => {
    const cache = new SystemPromptCache(wsDir);
    const prompt = cache.get("", "", "");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("includes memory content when provided", () => {
    const cache = new SystemPromptCache(wsDir);
    const prompt = cache.get("## My memory content", "", "");
    expect(prompt).toContain("My memory content");
  });

  it("includes skills summary when provided", () => {
    const cache = new SystemPromptCache(wsDir);
    const prompt = cache.get("", "<skills><skill>test</skill></skills>", "");
    expect(prompt).toContain("<skills>");
  });

  it("includes always-skills content when provided", () => {
    const cache = new SystemPromptCache(wsDir);
    const prompt = cache.get("", "", "### Skill: memory\n\nMemory instructions here.");
    expect(prompt).toContain("Memory instructions");
  });

  it("returns same string on second call (cache hit)", () => {
    const cache = new SystemPromptCache(wsDir);
    const first = cache.get("memory", "skills", "always");
    const second = cache.get("memory", "skills", "always");
    expect(first).toBe(second); // identical object reference — cache hit
  });

  it("rebuilds when memory content changes", () => {
    const cache = new SystemPromptCache(wsDir);
    const first = cache.get("memory v1", "", "");
    const second = cache.get("memory v2", "", "");
    expect(first).not.toBe(second);
  });

  it("rebuilds when skills summary changes", () => {
    const cache = new SystemPromptCache(wsDir);
    const first = cache.get("", "skills v1", "");
    const second = cache.get("", "skills v2", "");
    expect(first).not.toBe(second);
  });

  it("invalidate clears cached entry", () => {
    const cache = new SystemPromptCache(wsDir);
    const first = cache.get("mem", "skills", "");
    cache.invalidate();
    const second = cache.get("mem", "skills", "");
    // After invalidation + same inputs, a new string is built (not the old ref)
    expect(first).toEqual(second); // same content
  });

  it("includes bootstrap file content when file exists", () => {
    writeFileSync(join(wsDir, "AGENTS.md"), "# Custom agents instructions");
    const cache = new SystemPromptCache(wsDir);
    const prompt = cache.get("", "", "");
    expect(prompt).toContain("Custom agents instructions");
  });

  it("rebuilds prompt when bootstrap file mtime changes", async () => {
    const filePath = join(wsDir, "AGENTS.md");
    writeFileSync(filePath, "version 1");
    const cache = new SystemPromptCache(wsDir);
    const first = cache.get("", "", "");
    // Wait briefly then update the file
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(filePath, "version 2");
    // Touch mtime by reading stat
    const second = cache.get("", "", "");
    // Content changed so prompt should differ
    expect(second).toContain("version 2");
  });

  it("cleans up test directory", () => {
    rmSync(wsDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// buildMessages
// ---------------------------------------------------------------------------

describe("buildMessages", () => {
  it("creates messages with system + user", () => {
    const msgs = buildMessages({
      history: [],
      currentMessage: "Hello",
      systemPrompt: "You are helpful.",
    });
    expect(msgs[0]!["role"]).toBe("system");
    expect(msgs[0]!["content"]).toBe("You are helpful.");
    // Last message is user
    const last = msgs[msgs.length - 1]!;
    expect(last["role"]).toBe("user");
    const content = String(last["content"]);
    expect(content).toContain("Hello");
  });

  it("includes history messages between system and new user msg", () => {
    const history = [
      { role: "user", content: "prev question" },
      { role: "assistant", content: "prev answer" },
    ];
    const msgs = buildMessages({
      history,
      currentMessage: "follow up",
      systemPrompt: "sys",
    });
    // system + 2 history + 1 user = 4
    expect(msgs.length).toBe(4);
    expect(msgs[1]).toBe(history[0]); // same reference
  });

  it("includes channel + chatId in runtime context", () => {
    const msgs = buildMessages({
      history: [],
      currentMessage: "hi",
      systemPrompt: "sys",
      channel: "telegram",
      chatId: "chat123",
    });
    const userContent = String((msgs[msgs.length - 1]!["content"]));
    expect(userContent).toContain("telegram");
    expect(userContent).toContain("chat123");
  });

  it("merges consecutive user messages", () => {
    const history = [{ role: "user", content: "first" }];
    const msgs = buildMessages({
      history,
      currentMessage: "second",
      systemPrompt: "sys",
      currentRole: "user",
    });
    // Should merge into the existing user message, not add a new one
    const userMsgs = msgs.filter((m) => m["role"] === "user");
    expect(userMsgs).toHaveLength(1);
    const content = String(userMsgs[0]!["content"]);
    expect(content).toContain("first");
    expect(content).toContain("second");
  });
});
