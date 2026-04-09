/**
 * Tests for Phase 7: CommandRouter, built-in commands, CLI rendering.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { CommandRouter } from "../src/command/router.js";
import { registerBuiltinCommands, buildHelpText } from "../src/command/builtin.js";
import { markdownToAnsi, styled, ansi, isColorSupported, printResponse } from "../src/cli/render.js";
import type { CommandContext } from "../src/command/router.js";
import type { InboundMessage } from "../src/bus/events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(raw: string, loop: CommandContext["loop"] = null): CommandContext {
  const msg: InboundMessage = {
    channel: "cli",
    senderId: "user",
    chatId: "direct",
    content: raw,
  };
  return {
    msg,
    session: null,
    key: "cli:direct",
    raw,
    args: "",
    loop,
  };
}

// ---------------------------------------------------------------------------
// CommandRouter — core routing
// ---------------------------------------------------------------------------

describe("CommandRouter", () => {
  it("returns null for unrecognized commands", async () => {
    const router = new CommandRouter();
    const result = await router.dispatch(makeCtx("/unknown"));
    expect(result).toBeNull();
  });

  it("exact match dispatches correctly", async () => {
    const router = new CommandRouter();
    router.exact("/ping", async (ctx) => ({
      channel: ctx.msg.channel,
      chatId: ctx.msg.chatId,
      content: "pong",
    }));
    const result = await router.dispatch(makeCtx("/ping"));
    expect(result?.content).toBe("pong");
  });

  it("exact match is case-insensitive", async () => {
    const router = new CommandRouter();
    router.exact("/ping", async (ctx) => ({
      channel: ctx.msg.channel,
      chatId: ctx.msg.chatId,
      content: "pong",
    }));
    const result = await router.dispatch(makeCtx("/PING"));
    expect(result?.content).toBe("pong");
  });

  it("prefix match dispatches and sets args", async () => {
    const router = new CommandRouter();
    let capturedArgs = "";
    router.prefix("/note ", async (ctx) => {
      capturedArgs = ctx.args;
      return { channel: ctx.msg.channel, chatId: ctx.msg.chatId, content: "noted" };
    });
    await router.dispatch(makeCtx("/note hello world"));
    expect(capturedArgs).toBe("hello world");
  });

  it("longest prefix wins when multiple prefixes match", async () => {
    const router = new CommandRouter();
    const calls: string[] = [];
    router.prefix("/cmd", async () => {
      calls.push("short");
      return null;
    });
    router.prefix("/cmd sub", async () => {
      calls.push("long");
      return null;
    });
    await router.dispatch(makeCtx("/cmd sub stuff"));
    expect(calls).toEqual(["long"]);
  });

  it("interceptor fires when no exact/prefix matches", async () => {
    const router = new CommandRouter();
    router.intercept(async (ctx) => {
      if (ctx.raw.includes("?")) {
        return { channel: ctx.msg.channel, chatId: ctx.msg.chatId, content: "intercepted" };
      }
      return null;
    });
    const result = await router.dispatch(makeCtx("/what?"));
    expect(result?.content).toBe("intercepted");
  });

  it("interceptor is skipped when exact matches first", async () => {
    const router = new CommandRouter();
    router.exact("/exact", async (ctx) => ({
      channel: ctx.msg.channel, chatId: ctx.msg.chatId, content: "exact",
    }));
    router.intercept(async (ctx) => ({
      channel: ctx.msg.channel, chatId: ctx.msg.chatId, content: "interceptor",
    }));
    const result = await router.dispatch(makeCtx("/exact"));
    expect(result?.content).toBe("exact");
  });

  it("isPriority detects priority commands", () => {
    const router = new CommandRouter();
    router.priority("/stop", async () => null);
    expect(router.isPriority("/stop")).toBe(true);
    expect(router.isPriority("/other")).toBe(false);
  });

  it("isPriority is case-insensitive", () => {
    const router = new CommandRouter();
    router.priority("/stop", async () => null);
    expect(router.isPriority("/STOP")).toBe(true);
  });

  it("dispatchPriority calls priority handler", async () => {
    const router = new CommandRouter();
    router.priority("/stop", async (ctx) => ({
      channel: ctx.msg.channel, chatId: ctx.msg.chatId, content: "stopped",
    }));
    const result = await router.dispatchPriority(makeCtx("/stop"));
    expect(result?.content).toBe("stopped");
  });

  it("dispatchPriority returns null for non-priority commands", async () => {
    const router = new CommandRouter();
    router.exact("/help", async (ctx) => ({ channel: ctx.msg.channel, chatId: ctx.msg.chatId, content: "help" }));
    const result = await router.dispatchPriority(makeCtx("/help"));
    expect(result).toBeNull();
  });

  it("multiple interceptors are tried in order", async () => {
    const router = new CommandRouter();
    const order: number[] = [];
    router.intercept(async () => { order.push(1); return null; });
    router.intercept(async (ctx) => { order.push(2); return { channel: ctx.msg.channel, chatId: ctx.msg.chatId, content: "hit2" }; });
    router.intercept(async () => { order.push(3); return null; });
    const result = await router.dispatch(makeCtx("/any"));
    expect(order).toEqual([1, 2]);
    expect(result?.content).toBe("hit2");
  });
});

// ---------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------

describe("registerBuiltinCommands", () => {
  it("registers /help as exact command", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    const result = await router.dispatch(makeCtx("/help"));
    expect(result?.content).toContain("/help");
  });

  it("registers /status as priority command", () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    expect(router.isPriority("/status")).toBe(true);
  });

  it("registers /stop as priority command", () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    expect(router.isPriority("/stop")).toBe(true);
  });

  it("registers /restart as priority command", () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    expect(router.isPriority("/restart")).toBe(true);
  });

  it("/stop returns 'No active task' when loop is null", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    const result = await router.dispatchPriority(makeCtx("/stop"));
    expect(result?.content).toContain("No active task");
  });

  it("/stop cancels active tasks", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);

    let cancelled = false;
    const fakeLoop: CommandContext["loop"] = {
      model: "test-model",
      contextWindowTokens: 65536,
      lastUsage: {},
      startTime: Date.now() / 1000,
      sessions: {
        getOrCreate: () => { throw new Error("not used"); },
        save: () => {},
        invalidate: () => {},
      },
      activeTasks: new Map([
        ["cli:direct", [{ cancel: () => { cancelled = true; return true; }, done: false }]],
      ]),
      scheduleBackground: () => {},
      stop: () => {},
    };

    const ctx = makeCtx("/stop", fakeLoop);
    const result = await router.dispatchPriority(ctx);
    expect(cancelled).toBe(true);
    expect(result?.content).toContain("Stopped 1 task(s)");
  });

  it("/status returns model and uptime info", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);

    const fakeSession = {
      key: "cli:direct",
      messages: [],
      lastConsolidated: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      getHistory: () => [],
      clear: () => {},
    };

    const fakeLoop: CommandContext["loop"] = {
      model: "claude-opus-4-5",
      contextWindowTokens: 65536,
      lastUsage: { prompt_tokens: 100, completion_tokens: 50 },
      startTime: Date.now() / 1000 - 90, // 90s ago
      sessions: {
        getOrCreate: () => fakeSession as never,
        save: () => {},
        invalidate: () => {},
      },
      activeTasks: new Map(),
      scheduleBackground: () => {},
      stop: () => {},
    };

    const result = await router.dispatchPriority(makeCtx("/status", fakeLoop));
    expect(result?.content).toContain("claude-opus-4-5");
    expect(result?.content).toContain("1m 30s");
    expect(result?.metadata?.["renderAs"]).toBe("text");
  });

  it("/new returns 'New session started'", async () => {
    const router = new CommandRouter();
    registerBuiltinCommands(router);
    const result = await router.dispatch(makeCtx("/new"));
    expect(result?.content).toBe("New session started.");
  });
});

// ---------------------------------------------------------------------------
// buildHelpText
// ---------------------------------------------------------------------------

describe("buildHelpText", () => {
  it("includes all expected commands", () => {
    const text = buildHelpText();
    expect(text).toContain("/new");
    expect(text).toContain("/stop");
    expect(text).toContain("/restart");
    expect(text).toContain("/status");
    expect(text).toContain("/help");
  });
});

// ---------------------------------------------------------------------------
// markdownToAnsi (render.ts)
// ---------------------------------------------------------------------------

describe("markdownToAnsi", () => {
  // Force color off so output is predictable text without ANSI codes
  const origNoColor = process.env["NO_COLOR"];
  const origForceColor = process.env["FORCE_COLOR"];

  beforeAll(() => {
    process.env["NO_COLOR"] = "1";
    delete process.env["FORCE_COLOR"];
  });

  afterAll(() => {
    if (origNoColor !== undefined) process.env["NO_COLOR"] = origNoColor;
    else delete process.env["NO_COLOR"];
    if (origForceColor !== undefined) process.env["FORCE_COLOR"] = origForceColor;
  });

  it("passes plain text through unchanged", () => {
    expect(markdownToAnsi("hello world")).toBe("hello world");
  });

  it("preserves newlines", () => {
    expect(markdownToAnsi("line1\nline2")).toBe("line1\nline2");
  });

  it("passes bold text through unchanged (no color)", () => {
    // With NO_COLOR, markdownToAnsi returns raw text without stripping markers
    const result = markdownToAnsi("This is **bold** text");
    expect(result).toBe("This is **bold** text");
  });
});

// ---------------------------------------------------------------------------
// styled / isColorSupported
// ---------------------------------------------------------------------------

describe("styled", () => {
  it("returns plain text when NO_COLOR is set", () => {
    const prev = process.env["NO_COLOR"];
    process.env["NO_COLOR"] = "1";
    try {
      expect(styled("hello", ansi.red)).toBe("hello");
    } finally {
      if (prev !== undefined) process.env["NO_COLOR"] = prev;
      else delete process.env["NO_COLOR"];
    }
  });

  it("wraps text with ANSI codes when FORCE_COLOR is set", () => {
    const prevNC = process.env["NO_COLOR"];
    const prevFC = process.env["FORCE_COLOR"];
    delete process.env["NO_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    try {
      const result = styled("hello", ansi.red);
      expect(result).toContain("hello");
      expect(result).toContain("\x1b["); // ANSI escape present
    } finally {
      if (prevNC !== undefined) process.env["NO_COLOR"] = prevNC;
      if (prevFC !== undefined) process.env["FORCE_COLOR"] = prevFC;
      else delete process.env["FORCE_COLOR"];
    }
  });
});

// ---------------------------------------------------------------------------
// parseArgs (tested indirectly via flag helpers)
// ---------------------------------------------------------------------------

import { parseArgs } from "../src/cli/main.js";

describe("parseArgs", () => {
  it("parses positional arguments", () => {
    const { positional } = parseArgs(["agent"]);
    expect(positional).toEqual(["agent"]);
  });

  it("parses long flags with value", () => {
    const { flags } = parseArgs(["--message", "hello"]);
    expect(flags.get("message")).toBe("hello");
  });

  it("parses long boolean flags", () => {
    const { flags } = parseArgs(["--no-markdown"]);
    expect(flags.get("no-markdown")).toBe(true);
  });

  it("parses short flags with value", () => {
    const { flags } = parseArgs(["-m", "hello"]);
    expect(flags.get("m")).toBe("hello");
  });

  it("parses short boolean flags", () => {
    const { flags } = parseArgs(["-v"]);
    expect(flags.get("v")).toBe(true);
  });

  it("handles mixed positional and flags", () => {
    const { positional, flags } = parseArgs(["agent", "--config", "my.yaml", "--logs"]);
    expect(positional).toEqual(["agent"]);
    expect(flags.get("config")).toBe("my.yaml");
    expect(flags.get("logs")).toBe(true);
  });

  it("empty argv gives empty result", () => {
    const { positional, flags } = parseArgs([]);
    expect(positional).toHaveLength(0);
    expect(flags.size).toBe(0);
  });
});
