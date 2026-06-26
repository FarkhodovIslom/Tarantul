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
import { MemoryStore } from "../src/agent/memory.js";

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

    const history = readFileSync(join(tmpDir, "memory", "HISTORY.md"), "utf-8");
    expect(history).toContain("test message");

    const memory = store.readLongTerm();
    expect(memory).toContain("consolidation");
  });
});
