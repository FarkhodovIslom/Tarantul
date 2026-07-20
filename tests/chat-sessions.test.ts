import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_MEMORY_KEY,
  activePointerPath,
  fallbackTitle,
  isCliSessionKey,
  newCliSessionId,
  readActivePointer,
  relativeTime,
  resolveActiveCliSession,
  untitledLabel,
  writeActivePointer,
} from "../src/cli/chat-sessions.js";
import { Session } from "../src/session/manager.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tarantul-chat-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("newCliSessionId", () => {
  it("formats a sortable cli:YYYYMMDD-HHMMSS id", () => {
    const id = newCliSessionId(new Date(2026, 6, 20, 8, 15, 30)); // month is 0-based
    expect(id).toBe("cli:20260720-081530");
  });

  it("later timestamps sort after earlier ones lexicographically", () => {
    const a = newCliSessionId(new Date(2026, 0, 1, 0, 0, 0));
    const b = newCliSessionId(new Date(2026, 0, 1, 0, 0, 1));
    expect(a < b).toBe(true);
  });
});

describe("isCliSessionKey", () => {
  it("accepts the legacy key and minted ids, rejects other channels", () => {
    expect(isCliSessionKey("cli:direct")).toBe(true);
    expect(isCliSessionKey("cli:20260720-081530")).toBe(true);
    expect(isCliSessionKey("telegram:12345")).toBe(false);
    expect(isCliSessionKey("api:default")).toBe(false);
  });

  it("exposes the shared memory key as cli:direct", () => {
    expect(CLI_MEMORY_KEY).toBe("cli:direct");
  });
});

describe("fallbackTitle", () => {
  it("uses the first user message, collapsing whitespace", () => {
    const s = new Session({ key: "cli:x" });
    s.messages.push({ role: "user", content: "  hello   there\nworld " });
    expect(fallbackTitle(s)).toBe("hello there world");
  });

  it("truncates long first messages to 48 chars + ellipsis", () => {
    const s = new Session({ key: "cli:x" });
    s.messages.push({ role: "user", content: "x".repeat(100) });
    const t = fallbackTitle(s)!;
    expect(t.endsWith("…")).toBe(true);
    expect([...t].length).toBe(49); // 48 chars + ellipsis
  });

  it("skips assistant messages and returns null with no user message", () => {
    const s = new Session({ key: "cli:x" });
    s.messages.push({ role: "assistant", content: "hi" });
    expect(fallbackTitle(s)).toBeNull();
  });

  it("returns null for a blank first user message", () => {
    const s = new Session({ key: "cli:x" });
    s.messages.push({ role: "user", content: "   " });
    expect(fallbackTitle(s)).toBeNull();
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-07-20T12:00:00Z");
  it("buckets recent → minutes → hours → days → date", () => {
    expect(relativeTime(undefined, now)).toBe("");
    expect(relativeTime("2026-07-20T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-07-20T11:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2026-07-20T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-07-18T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("2026-06-01T12:00:00Z", now)).toBe("2026-06-01");
  });

  it("returns empty string for an unparseable timestamp", () => {
    expect(relativeTime("not-a-date", now)).toBe("");
  });
});

describe("untitledLabel", () => {
  it("formats minted ids and names the legacy key", () => {
    expect(untitledLabel("cli:20260720-081530")).toBe("2026-07-20 08:15");
    expect(untitledLabel("cli:direct")).toBe("(default session)");
    expect(untitledLabel("weird:key")).toBe("weird:key");
  });
});

describe("active pointer file", () => {
  it("round-trips a key and returns null when absent", () => {
    expect(readActivePointer(tmpDir)).toBeNull();
    writeActivePointer(tmpDir, "cli:20260720-081530");
    expect(existsSync(activePointerPath(tmpDir))).toBe(true);
    expect(readActivePointer(tmpDir)).toBe("cli:20260720-081530");
  });
});

describe("resolveActiveCliSession", () => {
  const now = new Date(2026, 6, 20, 8, 15, 30);

  it("resumes the pointer target when its file exists", () => {
    writeActivePointer(tmpDir, "cli:20260101-000000");
    const exists = (k: string) => k === "cli:20260101-000000";
    expect(resolveActiveCliSession(tmpDir, exists, now)).toEqual({
      key: "cli:20260101-000000",
      resumed: true,
    });
  });

  it("falls back to legacy cli:direct when the pointer target is gone", () => {
    writeActivePointer(tmpDir, "cli:deleted");
    const exists = (k: string) => k === "cli:direct";
    expect(resolveActiveCliSession(tmpDir, exists, now)).toEqual({
      key: "cli:direct",
      resumed: true,
    });
  });

  it("migrates to cli:direct when no pointer exists but the legacy file does", () => {
    const exists = (k: string) => k === "cli:direct";
    expect(resolveActiveCliSession(tmpDir, exists, now)).toEqual({
      key: "cli:direct",
      resumed: true,
    });
  });

  it("mints a fresh id when nothing exists", () => {
    const exists = () => false;
    expect(resolveActiveCliSession(tmpDir, exists, now)).toEqual({
      key: "cli:20260720-081530",
      resumed: false,
    });
  });

  it("mints a fresh id when the pointer is stale and no legacy file exists", () => {
    writeActivePointer(tmpDir, "cli:deleted");
    const exists = () => false;
    expect(resolveActiveCliSession(tmpDir, exists, now)).toEqual({
      key: "cli:20260720-081530",
      resumed: false,
    });
  });
});
