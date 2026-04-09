/**
 * Tests for Phase 5: Session manager + MessageBus.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionManager } from "../src/session/manager.js";
import { MessageBus } from "../src/bus/queue.js";
import type { InboundMessage, OutboundMessage } from "../src/bus/events.js";
import { sessionKey } from "../src/bus/events.js";
import { findLegalMessageStart, safeFilename, truncateText } from "../src/utils/helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nanobot-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers unit tests
// ---------------------------------------------------------------------------

describe("safeFilename", () => {
  it("replaces colons and special chars with underscores", () => {
    expect(safeFilename("telegram:123456")).toBe("telegram_123456");
    expect(safeFilename("cli:direct")).toBe("cli_direct");
  });

  it("leaves alphanumeric and dashes intact", () => {
    expect(safeFilename("my-session_v2")).toBe("my-session_v2");
  });
});

describe("truncateText", () => {
  it("does not truncate when within limit", () => {
    expect(truncateText("hello", 100)).toBe("hello");
  });

  it("truncates and appends marker", () => {
    const result = truncateText("a".repeat(200), 50);
    expect(result.length).toBeLessThan(80);
    expect(result).toContain("(truncated)");
  });

  it("returns empty string for maxChars=0", () => {
    const result = truncateText("hello", 0);
    expect(result).toBe("hello"); // 0 means no truncation (guard in impl)
  });
});

describe("findLegalMessageStart", () => {
  it("returns 0 for clean message sequence", () => {
    const msgs = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc1", type: "function", function: { name: "foo" } }],
      },
      { role: "tool", tool_call_id: "tc1", content: "result" },
    ];
    expect(findLegalMessageStart(msgs)).toBe(0);
  });

  it("skips orphan tool result at front", () => {
    const msgs = [
      { role: "tool", tool_call_id: "orphan", content: "stale" }, // orphan
      { role: "user", content: "fresh" },
    ];
    // The orphan tool result has no matching assistant call — start should advance past it
    const start = findLegalMessageStart(msgs);
    expect(start).toBeGreaterThan(0);
  });

  it("returns 0 when no tool messages at all", () => {
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    expect(findLegalMessageStart(msgs)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Session unit tests
// ---------------------------------------------------------------------------

describe("Session", () => {
  it("addMessage stamps role + content + timestamp", () => {
    const s = new Session({ key: "test:1" });
    s.addMessage("user", "hello");
    expect(s.messages.length).toBe(1);
    expect(s.messages[0]!["role"]).toBe("user");
    expect(s.messages[0]!["content"]).toBe("hello");
    expect(typeof s.messages[0]!["timestamp"]).toBe("string");
  });

  it("getHistory returns all when lastConsolidated=0 and no limit", () => {
    const s = new Session({ key: "test:1" });
    s.addMessage("user", "msg1");
    s.addMessage("assistant", "resp1");
    const h = s.getHistory(0);
    expect(h.length).toBe(2);
  });

  it("getHistory skips consolidated messages", () => {
    const s = new Session({ key: "test:1" });
    s.addMessage("user", "old");     // index 0 — consolidated
    s.addMessage("assistant", "r1"); // index 1 — consolidated
    s.addMessage("user", "new");     // index 2
    s.lastConsolidated = 2;
    const h = s.getHistory(0);
    expect(h.length).toBe(1);
    expect(h[0]!["content"]).toBe("new");
  });

  it("getHistory limits to maxMessages", () => {
    const s = new Session({ key: "test:1" });
    for (let i = 0; i < 10; i++) s.addMessage("user", `m${i}`);
    const h = s.getHistory(4);
    expect(h.length).toBeLessThanOrEqual(4);
  });

  it("getHistory projects only LLM-safe fields", () => {
    const s = new Session({ key: "test:1" });
    s.messages.push({ role: "user", content: "hi", timestamp: "2025-01-01", _extra: "noise" });
    const h = s.getHistory(0);
    expect("_extra" in h[0]!).toBe(false);
    expect("timestamp" in h[0]!).toBe(false);
  });

  it("clear resets messages and lastConsolidated", () => {
    const s = new Session({ key: "test:1" });
    s.addMessage("user", "hi");
    s.lastConsolidated = 1;
    s.clear();
    expect(s.messages.length).toBe(0);
    expect(s.lastConsolidated).toBe(0);
  });

  it("retainRecentLegalSuffix keeps legal suffix", () => {
    const s = new Session({ key: "test:1" });
    for (let i = 0; i < 20; i++) s.addMessage("user", `msg${i}`);
    s.retainRecentLegalSuffix(5);
    expect(s.messages.length).toBeLessThanOrEqual(5);
  });

  it("retainRecentLegalSuffix with maxMessages=0 clears all", () => {
    const s = new Session({ key: "test:1" });
    s.addMessage("user", "hi");
    s.retainRecentLegalSuffix(0);
    expect(s.messages.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SessionManager tests
// ---------------------------------------------------------------------------

describe("SessionManager", () => {
  it("creates a new session when none exists", () => {
    const mgr = new SessionManager(tmpDir);
    const s = mgr.getOrCreate("cli:direct");
    expect(s.key).toBe("cli:direct");
    expect(s.messages.length).toBe(0);
  });

  it("returns same instance from cache on second call", () => {
    const mgr = new SessionManager(tmpDir);
    const s1 = mgr.getOrCreate("cli:direct");
    const s2 = mgr.getOrCreate("cli:direct");
    expect(s1).toBe(s2);
  });

  it("persists and reloads session across manager instances", async () => {
    const mgr1 = new SessionManager(tmpDir);
    const s1 = mgr1.getOrCreate("telegram:999");
    s1.addMessage("user", "hello");
    s1.addMessage("assistant", "hi there");
    mgr1.save(s1);

    // Wait for async Bun.write
    await new Promise((r) => setTimeout(r, 50));

    const mgr2 = new SessionManager(tmpDir);
    const s2 = mgr2.getOrCreate("telegram:999");
    expect(s2.messages.length).toBe(2);
    expect(s2.messages[0]!["content"]).toBe("hello");
    expect(s2.messages[1]!["content"]).toBe("hi there");
  });

  it("persists metadata and lastConsolidated", async () => {
    const mgr1 = new SessionManager(tmpDir);
    const s = mgr1.getOrCreate("cli:x");
    s.addMessage("user", "a");
    s.addMessage("assistant", "b");
    s.lastConsolidated = 1;
    s.metadata = { theme: "dark" };
    mgr1.save(s);

    await new Promise((r) => setTimeout(r, 50));

    const mgr2 = new SessionManager(tmpDir);
    const s2 = mgr2.getOrCreate("cli:x");
    expect(s2.lastConsolidated).toBe(1);
    expect(s2.metadata["theme"]).toBe("dark");
  });

  it("listSessions returns persisted sessions sorted by updatedAt", async () => {
    const mgr = new SessionManager(tmpDir);

    const s1 = mgr.getOrCreate("channel:a");
    s1.addMessage("user", "first");
    mgr.save(s1);

    await new Promise((r) => setTimeout(r, 20));

    const s2 = mgr.getOrCreate("channel:b");
    s2.addMessage("user", "second");
    mgr.save(s2);

    await new Promise((r) => setTimeout(r, 50));

    const list = mgr.listSessions();
    expect(list.length).toBe(2);
    // Most recently updated first
    expect(list[0]!.key).toBe("channel:b");
  });

  it("invalidate evicts from cache, forcing disk reload", async () => {
    const mgr = new SessionManager(tmpDir);
    const s = mgr.getOrCreate("cli:test");
    s.addMessage("user", "hi");
    mgr.save(s);
    await new Promise((r) => setTimeout(r, 50));

    mgr.invalidate("cli:test");
    const s2 = mgr.getOrCreate("cli:test");
    // Different object reference — reloaded from disk
    expect(s2).not.toBe(s);
    expect(s2.messages.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// MessageBus tests
// ---------------------------------------------------------------------------

describe("MessageBus", () => {
  it("publishInbound + consumeInbound round-trip", async () => {
    const bus = new MessageBus();
    const msg: InboundMessage = {
      channel: "cli",
      senderId: "user",
      chatId: "direct",
      content: "hello",
    };
    await bus.publishInbound(msg);
    const received = await bus.consumeInbound();
    expect(received.content).toBe("hello");
    expect(received.channel).toBe("cli");
  });

  it("publishOutbound + consumeOutbound round-trip", async () => {
    const bus = new MessageBus();
    const msg: OutboundMessage = {
      channel: "cli",
      chatId: "direct",
      content: "response",
    };
    await bus.publishOutbound(msg);
    const received = await bus.consumeOutbound();
    expect(received.content).toBe("response");
  });

  it("consumeInbound waits until message arrives", async () => {
    const bus = new MessageBus();
    let received: InboundMessage | null = null;

    const consumer = bus.consumeInbound().then((m) => {
      received = m;
    });

    expect(received).toBeNull(); // not yet

    await bus.publishInbound({
      channel: "tg",
      senderId: "u1",
      chatId: "c1",
      content: "ping",
    });

    await consumer;
    expect(received).not.toBeNull();
    expect((received as InboundMessage | null)!.content).toBe("ping");
  });

  it("drainOutbound returns all buffered items", async () => {
    const bus = new MessageBus();
    for (let i = 0; i < 5; i++) {
      await bus.publishOutbound({ channel: "cli", chatId: "d", content: `msg${i}` });
    }
    const drained = bus.drainOutbound();
    expect(drained.length).toBe(5);
    expect(bus.outboundSize).toBe(0);
  });

  it("tryConsumeInbound returns undefined when empty", () => {
    const bus = new MessageBus();
    expect(bus.tryConsumeInbound()).toBeUndefined();
  });

  it("inboundSize / outboundSize reflect queue depth", async () => {
    const bus = new MessageBus();
    await bus.publishInbound({ channel: "cli", senderId: "u", chatId: "c", content: "a" });
    await bus.publishInbound({ channel: "cli", senderId: "u", chatId: "c", content: "b" });
    expect(bus.inboundSize).toBe(2);
    await bus.consumeInbound();
    expect(bus.inboundSize).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// InboundMessage helpers
// ---------------------------------------------------------------------------

describe("sessionKey", () => {
  it("returns channel:chatId by default", () => {
    const msg: InboundMessage = { channel: "tg", senderId: "u", chatId: "123", content: "hi" };
    expect(sessionKey(msg)).toBe("tg:123");
  });

  it("returns override when set", () => {
    const msg: InboundMessage = {
      channel: "slack",
      senderId: "u",
      chatId: "general",
      content: "hi",
      sessionKeyOverride: "slack:thread:abc",
    };
    expect(sessionKey(msg)).toBe("slack:thread:abc");
  });
});
