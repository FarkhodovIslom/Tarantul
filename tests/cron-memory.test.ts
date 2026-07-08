/**
 * Tests for Phase 6: CronService + CronTool + MemoryStore.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CronService } from "../src/cron/service.js";
import { CronTool } from "../src/agent/tools/cron.js";
import { computeNextRun, nowMs, validateTimezone } from "../src/cron/types.js";
import { MemoryStore, MemoryStoreRegistry, MemoryConsolidator } from "../src/agent/memory.js";
import { SessionManager } from "../src/session/manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tarantul-cron-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// computeNextRun
// ---------------------------------------------------------------------------

describe("computeNextRun", () => {
  it("at: returns atMs when in the future", () => {
    const future = nowMs() + 60_000;
    expect(computeNextRun({ kind: "at", atMs: future }, nowMs())).toBe(future);
  });

  it("at: returns null when in the past", () => {
    const past = nowMs() - 1000;
    expect(computeNextRun({ kind: "at", atMs: past }, nowMs())).toBeNull();
  });

  it("every: returns now + interval", () => {
    const from = 1_000_000;
    const result = computeNextRun({ kind: "every", everyMs: 5000 }, from);
    expect(result).toBe(from + 5000);
  });

  it("every: returns null for zero interval", () => {
    expect(computeNextRun({ kind: "every", everyMs: 0 }, nowMs())).toBeNull();
  });

  it("cron: computes a valid future date for '* * * * *'", () => {
    const from = nowMs();
    const next = computeNextRun({ kind: "cron", expr: "* * * * *" }, from);
    // Should be within the next 2 minutes
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(from);
    expect(next!).toBeLessThan(from + 2 * 60 * 1_000);
  });

  it("cron: returns null for invalid expression", () => {
    expect(computeNextRun({ kind: "cron", expr: "invalid!!" }, nowMs())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateTimezone
// ---------------------------------------------------------------------------

describe("validateTimezone", () => {
  it("returns null for valid timezone", () => {
    expect(validateTimezone("America/New_York")).toBeNull();
    expect(validateTimezone("UTC")).toBeNull();
    expect(validateTimezone("Europe/Moscow")).toBeNull();
  });

  it("returns error string for invalid timezone", () => {
    const err = validateTimezone("Narnia/Lamppost");
    expect(err).not.toBeNull();
    expect(err).toContain("Narnia/Lamppost");
  });
});

// ---------------------------------------------------------------------------
// CronService
// ---------------------------------------------------------------------------

describe("CronService", () => {
  function makeService(callback?: (job: unknown) => Promise<string | null>) {
    const storePath = join(tmpDir, "jobs.json");
    return new CronService(storePath, callback ?? null);
  }

  it("starts with empty store", async () => {
    const svc = makeService();
    await svc.start();
    expect(svc.listJobs().length).toBe(0);
    svc.stop();
  });

  it("addJob creates a job with computed nextRunAtMs", async () => {
    const svc = makeService();
    await svc.start();
    const job = svc.addJob({
      name: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "hello",
    });
    expect(job.id.length).toBeGreaterThan(0);
    expect(job.enabled).toBe(true);
    expect(job.state.nextRunAtMs).toBeGreaterThan(nowMs());
    svc.stop();
  });

  it("removeJob deletes by id", async () => {
    const svc = makeService();
    await svc.start();
    const job = svc.addJob({
      name: "del",
      schedule: { kind: "every", everyMs: 1000 },
      message: "bye",
    });
    expect(svc.removeJob(job.id)).toBe(true);
    expect(svc.listJobs().length).toBe(0);
    svc.stop();
  });

  it("removeJob returns false for unknown id", async () => {
    const svc = makeService();
    await svc.start();
    expect(svc.removeJob("nonexistent")).toBe(false);
    svc.stop();
  });

  it("persists and reloads jobs across instances", async () => {
    const storePath = join(tmpDir, "jobs.json");
    const svc1 = new CronService(storePath);
    await svc1.start();
    svc1.addJob({
      name: "persist-test",
      schedule: { kind: "every", everyMs: 30_000 },
      message: "check",
    });
    svc1.stop();

    // New instance should load persisted jobs
    const svc2 = new CronService(storePath);
    await svc2.start();
    const jobs = svc2.listJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.name).toBe("persist-test");
    svc2.stop();
  });

  it("enableJob disables and re-enables a job", async () => {
    const svc = makeService();
    await svc.start();
    const job = svc.addJob({
      name: "toggle",
      schedule: { kind: "every", everyMs: 5000 },
      message: "hi",
    });

    svc.enableJob(job.id, false);
    expect(svc.getJob(job.id)!.enabled).toBe(false);
    expect(svc.listJobs(false).length).toBe(0); // disabled jobs filtered

    svc.enableJob(job.id, true);
    expect(svc.getJob(job.id)!.enabled).toBe(true);
    expect(svc.listJobs(false).length).toBe(1);
    svc.stop();
  });

  it("runJob executes the callback", async () => {
    let called = false;
    const svc = makeService(async () => {
      called = true;
      return null;
    });
    await svc.start();
    const job = svc.addJob({
      name: "manual",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "run now",
    });
    const ok = await svc.runJob(job.id, true);
    expect(ok).toBe(true);
    expect(called).toBe(true);
    svc.stop();
  });

  it("at-schedule job: deleteAfterRun removes it after execution", async () => {
    const svc = makeService(async () => null);
    await svc.start();
    const futureMs = nowMs() + 1000;
    const job = svc.addJob({
      name: "oneshot",
      schedule: { kind: "at", atMs: futureMs },
      message: "once",
      deleteAfterRun: true,
    });
    await svc.runJob(job.id, true);
    expect(svc.getJob(job.id)).toBeNull();
    svc.stop();
  });

  it("status() reflects running state", async () => {
    const svc = makeService();
    await svc.start();
    const st = svc.status();
    expect(st.enabled).toBe(true);
    svc.stop();
    expect(svc.status().enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CronTool
// ---------------------------------------------------------------------------

describe("CronTool", () => {
  function makeTool() {
    const storePath = join(tmpDir, "cron-tool.json");
    const svc = new CronService(storePath);
    const tool = new CronTool(svc, "UTC");
    tool.setContext("cli", "direct");
    return { svc, tool };
  }

  it("add + list + remove round-trip", async () => {
    const { svc, tool } = makeTool();
    await svc.start();

    const addResult = await tool.execute({
      action: "add",
      message: "remind me",
      every_seconds: 60,
    });
    expect(addResult).toContain("Created job");

    const listResult = await tool.execute({ action: "list" });
    expect(listResult).toContain("remind me");

    const jobId = svc.listJobs()[0]!.id;
    const removeResult = await tool.execute({ action: "remove", job_id: jobId });
    expect(removeResult).toContain("Removed job");

    svc.stop();
  });

  it("list returns empty message when no jobs", async () => {
    const { svc, tool } = makeTool();
    await svc.start();
    const result = await tool.execute({ action: "list" });
    expect(result).toBe("No scheduled jobs.");
    svc.stop();
  });

  it("add requires message", async () => {
    const { svc, tool } = makeTool();
    await svc.start();
    const result = await tool.execute({ action: "add", every_seconds: 60 });
    expect(result).toContain("Error");
    svc.stop();
  });

  it("add requires scheduling field", async () => {
    const { svc, tool } = makeTool();
    await svc.start();
    const result = await tool.execute({ action: "add", message: "hi" });
    expect(result).toContain("Error");
    svc.stop();
  });

  it("remove requires job_id", async () => {
    const { svc, tool } = makeTool();
    await svc.start();
    const result = await tool.execute({ action: "remove" });
    expect(result).toContain("Error");
    svc.stop();
  });

  it("blocks new jobs inside cron context", async () => {
    const { svc, tool } = makeTool();
    await svc.start();
    tool.setCronContext(true);
    const result = await tool.execute({
      action: "add",
      message: "nested",
      every_seconds: 10,
    });
    expect(result).toContain("Error");
    svc.stop();
  });

  it("has correct name and description", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe("cron");
    expect(tool.description).toContain("Schedule");
    expect(tool.parameters["required"]).toContain("action");
  });
});

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

describe("MemoryStore", () => {
  it("readLongTerm returns empty string if no file", () => {
    const store = new MemoryStore(tmpDir);
    expect(store.readLongTerm()).toBe("");
  });

  it("writeLongTerm + readLongTerm round-trip", () => {
    const store = new MemoryStore(tmpDir);
    store.writeLongTerm("# My Memory\nFact: cats are great");
    expect(store.readLongTerm()).toContain("cats are great");
  });

  it("appendHistory creates and appends to HISTORY.md", () => {
    const store = new MemoryStore(tmpDir);
    store.appendHistory("[2025-01-01 09:00] USER: hello");
    store.appendHistory("[2025-01-01 09:01] ASSISTANT: hi");
    const content = readFileSync(join(tmpDir, "memory", "HISTORY.md"), "utf-8");
    expect(content).toContain("hello");
    expect(content).toContain("hi");
  });

  it("getMemoryContext wraps content with heading", () => {
    const store = new MemoryStore(tmpDir);
    store.writeLongTerm("fact1");
    const ctx = store.getMemoryContext();
    expect(ctx).toContain("## Long-term Memory");
    expect(ctx).toContain("fact1");
  });

  it("getMemoryContext returns empty string when no memory", () => {
    const store = new MemoryStore(tmpDir);
    expect(store.getMemoryContext()).toBe("");
  });

  it("consolidate writes memory and history via mock provider", async () => {
    const store = new MemoryStore(tmpDir);

    // Mock provider that returns a save_memory tool call
    const mockProvider = {
      generation: { temperature: 0.7, maxTokens: 4096, reasoningEffort: null },
      getDefaultModel: () => "mock",
      chatWithRetry: async () => ({
        content: null,
        toolCalls: [
          {
            id: "tc1",
            name: "save_memory",
            arguments: {
              history_entry: "[2025-01-01 10:00] USER: test message",
              memory_update: "# Memory\nUser tested consolidation.",
            },
          },
        ],
        finishReason: "tool_calls",
        usage: {},
      }),
    };

    const messages = [
      { role: "user", content: "test message", timestamp: "2025-01-01T10:00:00" },
    ];

    const ok = await store.consolidate(
      messages,
      mockProvider as never,
      "mock",
    );
    expect(ok).toBe(true);

    // Consolidation routes the history entry to today's daily log (OpenClaw-style).
    const history = readFileSync(store.dailyLogPath(), "utf-8");
    expect(history).toContain("test message");

    const memory = store.readLongTerm();
    expect(memory).toContain("consolidation");
  });

  it("consolidate writes atomic notes with wikilinks", async () => {
    const store = new MemoryStore(tmpDir);
    const mockProvider = {
      generation: { temperature: 0.7, maxTokens: 4096, reasoningEffort: null },
      getDefaultModel: () => "mock",
      chatWithRetry: async () => ({
        content: null,
        toolCalls: [
          {
            id: "tc1",
            name: "save_memory",
            arguments: {
              history_entry: "[2025-01-01 10:00] Discussed the rocket program.",
              memory_update: "# Memory\nActive project: [[Apollo]] led by [[Alice]].",
              notes: [
                { name: "Apollo", content: "Flagship rocket program. Led by [[Alice]]." },
                { name: "Alice", content: "Lead engineer on [[Apollo]].", mode: "replace" },
              ],
            },
          },
        ],
        finishReason: "tool_calls",
        usage: {},
      }),
    };

    const ok = await store.consolidate(
      [{ role: "user", content: "tell me about apollo", timestamp: "2025-01-01T10:00:00" }],
      mockProvider as never,
      "mock",
    );
    expect(ok).toBe(true);

    // Atomic notes are written under notes/ with their wikilinks intact.
    expect(store.readNote("Apollo")).toContain("Flagship rocket program");
    expect(store.readNote("Apollo")).toContain("[[Alice]]");
    expect(store.readNote("Alice")).toContain("[[Apollo]]");
    expect(store.listNoteNames().sort()).toEqual(["Alice", "Apollo"]);
    // The curated index references the notes.
    expect(store.readLongTerm()).toContain("[[Apollo]]");
  });

  it("fires onConsolidated (reindex hook) once after writing memory", async () => {
    const sessions = new SessionManager(tmpDir);
    const session = sessions.getOrCreate("cli:direct");
    for (let i = 0; i < 3; i++) {
      session.addMessage("user", `question ${i} about apollo`);
      session.addMessage("assistant", `answer ${i}`);
    }

    const mockProvider = {
      generation: { temperature: 0.7, maxTokens: 4096, reasoningEffort: null },
      getDefaultModel: () => "mock",
      chatWithRetry: async () => ({
        content: null,
        finishReason: "tool_calls",
        usage: {},
        toolCalls: [
          {
            id: "t1",
            name: "save_memory",
            arguments: {
              history_entry: "[2026-07-08 10:00] Discussed Apollo.",
              memory_update: "# Memory\n[[Apollo]] is active.",
              notes: [{ name: "Apollo", content: "Rocket program." }],
            },
          },
        ],
      }),
    };

    const reindexed: string[] = [];
    const consolidator = new MemoryConsolidator({
      workspace: tmpDir,
      provider: mockProvider as never,
      model: "mock",
      sessions,
      // budget = 1025 - 0 - 1024 = 1 → any non-empty session exceeds it.
      contextWindowTokens: 1025,
      maxCompletionTokens: 0,
      buildMessages: (o) => o.history,
      getToolDefinitions: () => [],
      onConsolidated: (key) => {
        reindexed.push(key);
      },
    });

    await consolidator.maybeConsolidateByTokens(session);

    // The hook fired exactly once, for this session, after notes were written.
    expect(reindexed).toEqual(["cli:direct"]);
    expect(consolidator.stores.for("cli:direct").readNote("Apollo")).toContain("Rocket program");
  });

  it("scopes memory per session key (no cross-chat leakage)", () => {
    const a = new MemoryStore(tmpDir, "telegram:111");
    const b = new MemoryStore(tmpDir, "slack:222");
    a.writeLongTerm("chat A secret");
    b.writeLongTerm("chat B secret");
    // Each key sees only its own memory.
    expect(a.readLongTerm()).toContain("chat A secret");
    expect(a.readLongTerm()).not.toContain("chat B secret");
    expect(b.readLongTerm()).toContain("chat B secret");
    expect(b.readLongTerm()).not.toContain("chat A secret");
    // A keyed store must not read the global store's file, and vice versa.
    const global = new MemoryStore(tmpDir);
    expect(global.readLongTerm()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// MemoryStoreRegistry
// ---------------------------------------------------------------------------

describe("MemoryStoreRegistry", () => {
  it("returns the same store instance for the same key", () => {
    const reg = new MemoryStoreRegistry(tmpDir);
    expect(reg.for("telegram:1")).toBe(reg.for("telegram:1"));
  });

  it("isolates memory between distinct keys", () => {
    const reg = new MemoryStoreRegistry(tmpDir);
    reg.for("a:1").writeLongTerm("A");
    reg.for("b:2").writeLongTerm("B");
    expect(reg.for("a:1").readLongTerm()).toBe("A");
    expect(reg.for("b:2").readLongTerm()).toBe("B");
  });
});
