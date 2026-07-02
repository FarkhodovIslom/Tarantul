

import { existsSync, statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../utils/logger.js";
import {
  type CronJob,
  type CronPayload,
  type CronSchedule,
  type CronStore,
  type CronStatus,
  nowMs,
  computeNextRun,
  validateTimezone,
} from "./types.js";

const MAX_RUN_HISTORY = 20;
/** setTimeout delays above this (~24.8 days) overflow to 0 and fire immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// Serialization helpers (JSON ↔ domain types)
// ---------------------------------------------------------------------------

function deserializeStore(raw: string): CronStore {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const jobs: CronJob[] = [];

  for (const j of (data["jobs"] as Record<string, unknown>[]) ?? []) {
    const sched = j["schedule"] as Record<string, unknown>;
    const pay = j["payload"] as Record<string, unknown>;
    const st = (j["state"] as Record<string, unknown> | undefined) ?? {};

    jobs.push({
      id: j["id"] as string,
      name: j["name"] as string,
      enabled: (j["enabled"] as boolean | undefined) ?? true,
      schedule: {
        kind: sched["kind"] as CronSchedule["kind"],
        atMs: (sched["atMs"] as number | undefined) ?? null,
        everyMs: (sched["everyMs"] as number | undefined) ?? null,
        expr: (sched["expr"] as string | undefined) ?? null,
        tz: (sched["tz"] as string | undefined) ?? null,
      },
      payload: {
        kind: ((pay["kind"] as string | undefined) ?? "agent_turn") as CronPayload["kind"],
        message: (pay["message"] as string | undefined) ?? "",
        deliver: (pay["deliver"] as boolean | undefined) ?? false,
        channel: (pay["channel"] as string | undefined) ?? null,
        to: (pay["to"] as string | undefined) ?? null,
      },
      state: {
        nextRunAtMs: (st["nextRunAtMs"] as number | undefined) ?? null,
        lastRunAtMs: (st["lastRunAtMs"] as number | undefined) ?? null,
        lastStatus: (st["lastStatus"] as CronStatus | undefined) ?? null,
        lastError: (st["lastError"] as string | undefined) ?? null,
        runHistory: ((st["runHistory"] as Record<string, unknown>[] | undefined) ?? []).map((r) => ({
          runAtMs: r["runAtMs"] as number,
          status: r["status"] as CronStatus,
          durationMs: (r["durationMs"] as number | undefined) ?? 0,
          error: (r["error"] as string | undefined) ?? null,
        })),
      },
      createdAtMs: (j["createdAtMs"] as number | undefined) ?? 0,
      updatedAtMs: (j["updatedAtMs"] as number | undefined) ?? 0,
      deleteAfterRun: (j["deleteAfterRun"] as boolean | undefined) ?? false,
    });
  }

  return { version: (data["version"] as number | undefined) ?? 1, jobs };
}

function serializeStore(store: CronStore): string {
  return JSON.stringify(
    {
      version: store.version,
      jobs: store.jobs.map((j) => ({
        id: j.id,
        name: j.name,
        enabled: j.enabled,
        schedule: {
          kind: j.schedule.kind,
          atMs: j.schedule.atMs ?? null,
          everyMs: j.schedule.everyMs ?? null,
          expr: j.schedule.expr ?? null,
          tz: j.schedule.tz ?? null,
        },
        payload: {
          kind: j.payload.kind,
          message: j.payload.message,
          deliver: j.payload.deliver,
          channel: j.payload.channel ?? null,
          to: j.payload.to ?? null,
        },
        state: {
          nextRunAtMs: j.state.nextRunAtMs ?? null,
          lastRunAtMs: j.state.lastRunAtMs ?? null,
          lastStatus: j.state.lastStatus ?? null,
          lastError: j.state.lastError ?? null,
          runHistory: j.state.runHistory.map((r) => ({
            runAtMs: r.runAtMs,
            status: r.status,
            durationMs: r.durationMs,
            error: r.error ?? null,
          })),
        },
        createdAtMs: j.createdAtMs,
        updatedAtMs: j.updatedAtMs,
        deleteAfterRun: j.deleteAfterRun,
      })),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// CronService
// ---------------------------------------------------------------------------

export type CronJobCallback = (job: CronJob) => Promise<string | null>;

export class CronService {
  private store: CronStore | null = null;
  private lastMtime = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly storePath: string,
    private readonly onJob: CronJobCallback | null = null,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.running = true;
    this._loadStore();
    this._recomputeNextRuns();
    this._saveStore();
    this._armTimer();
    const n = this.store?.jobs.length ?? 0;
    logger.info({ jobs: n }, "Cron service started");
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  listJobs(includeDisabled = false): CronJob[] {
    const store = this._loadStore();
    const jobs = includeDisabled ? store.jobs : store.jobs.filter((j) => j.enabled);
    return jobs.slice().sort((a, b) => {
      const ta = a.state.nextRunAtMs ?? Number.POSITIVE_INFINITY;
      const tb = b.state.nextRunAtMs ?? Number.POSITIVE_INFINITY;
      return ta - tb;
    });
  }

  addJob(opts: {
    name: string;
    schedule: CronSchedule;
    message: string;
    deliver?: boolean;
    channel?: string | null;
    to?: string | null;
    deleteAfterRun?: boolean;
  }): CronJob {
    const store = this._loadStore();
    _validateScheduleForAdd(opts.schedule);

    const now = nowMs();
    const job: CronJob = {
      id: crypto.randomUUID().slice(0, 8),
      name: opts.name,
      enabled: true,
      schedule: opts.schedule,
      payload: {
        kind: "agent_turn",
        message: opts.message,
        deliver: opts.deliver ?? false,
        channel: opts.channel ?? null,
        to: opts.to ?? null,
      },
      state: {
        nextRunAtMs: computeNextRun(opts.schedule, now),
        runHistory: [],
      },
      createdAtMs: now,
      updatedAtMs: now,
      deleteAfterRun: opts.deleteAfterRun ?? false,
    };

    store.jobs.push(job);
    this._saveStore();
    this._armTimer();
    logger.info({ name: opts.name, id: job.id }, "Cron: job added");
    return job;
  }

  removeJob(jobId: string): boolean {
    const store = this._loadStore();
    const before = store.jobs.length;
    store.jobs = store.jobs.filter((j) => j.id !== jobId);
    if (store.jobs.length < before) {
      this._saveStore();
      this._armTimer();
      logger.info({ jobId }, "Cron: job removed");
      return true;
    }
    return false;
  }

  enableJob(jobId: string, enabled: boolean): CronJob | null {
    const store = this._loadStore();
    const job = store.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    job.enabled = enabled;
    job.updatedAtMs = nowMs();
    job.state.nextRunAtMs = enabled ? computeNextRun(job.schedule, nowMs()) : null;
    this._saveStore();
    this._armTimer();
    return job;
  }

  async runJob(jobId: string, force = false): Promise<boolean> {
    const store = this._loadStore();
    const job = store.jobs.find((j) => j.id === jobId);
    if (!job) return false;
    if (!force && !job.enabled) return false;
    await this._executeJob(job);
    this._saveStore();
    this._armTimer();
    return true;
  }

  getJob(jobId: string): CronJob | null {
    const store = this._loadStore();
    return store.jobs.find((j) => j.id === jobId) ?? null;
  }

  status(): { enabled: boolean; jobs: number; nextWakeAtMs: number | null } {
    const store = this._loadStore();
    return {
      enabled: this.running,
      jobs: store.jobs.length,
      nextWakeAtMs: this._getNextWakeMs(),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal scheduling
  // ---------------------------------------------------------------------------

  private _loadStore(): CronStore {
    // Reload if file changed externally (mtime check)
    if (this.store && existsSync(this.storePath)) {
      const mtime = statSync(this.storePath).mtimeMs;
      if (mtime !== this.lastMtime) {
        logger.info("Cron: store modified externally, reloading");
        this.store = null;
      }
    }
    if (this.store) return this.store;

    if (existsSync(this.storePath)) {
      try {
        const raw = require("node:fs").readFileSync(this.storePath, "utf-8") as string;
        this.store = deserializeStore(raw);
        this.lastMtime = statSync(this.storePath).mtimeMs;
      } catch (err) {
        logger.warn({ err }, "Failed to load cron store, starting empty");
        this.store = { version: 1, jobs: [] };
      }
    } else {
      this.store = { version: 1, jobs: [] };
    }

    return this.store;
  }

  private _saveStore(): void {
    if (!this.store) return;
    try {
      const dir = dirname(this.storePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      require("node:fs").writeFileSync(this.storePath, serializeStore(this.store), "utf-8");
      this.lastMtime = statSync(this.storePath).mtimeMs;
    } catch (err) {
      logger.error({ err }, "Failed to save cron store");
    }
  }

  private _recomputeNextRuns(): void {
    if (!this.store) return;
    const now = nowMs();
    for (const job of this.store.jobs) {
      if (!job.enabled) continue;
      if (job.schedule.kind === "at") {
        // Preserve the one-shot target. computeNextRun() returns null for a
        // past time, which would silently drop a run missed while the process
        // was down; keeping atMs makes it immediately due instead.
        job.state.nextRunAtMs = job.schedule.atMs ?? job.state.nextRunAtMs ?? null;
      } else {
        job.state.nextRunAtMs = computeNextRun(job.schedule, now);
      }
    }
  }

  private _getNextWakeMs(): number | null {
    if (!this.store) return null;
    const times = this.store.jobs
      .filter((j) => j.enabled && j.state.nextRunAtMs != null)
      .map((j) => j.state.nextRunAtMs as number);
    return times.length ? Math.min(...times) : null;
  }

  private _armTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running) return;

    const nextWake = this._getNextWakeMs();
    if (nextWake === null) return;

    // Clamp to the 32-bit setTimeout ceiling. Delays beyond it overflow and
    // fire immediately; instead we wake at the ceiling and re-arm, walking
    // toward the true target in ~24-day hops.
    const delayMs = Math.min(Math.max(0, nextWake - nowMs()), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running) return;
      // If we only advanced to the interim ceiling, re-arm without firing jobs.
      if (nowMs() < nextWake) {
        this._armTimer();
        return;
      }
      this._onTimer().catch((err) => logger.error({ err }, "Cron timer error"));
    }, delayMs);
  }

  private async _onTimer(): Promise<void> {
    this._loadStore();
    if (!this.store) return;

    const now = nowMs();
    const dueJobs = this.store.jobs.filter(
      (j) => j.enabled && j.state.nextRunAtMs != null && now >= j.state.nextRunAtMs,
    );

    for (const job of dueJobs) {
      await this._executeJob(job);
    }

    this._saveStore();
    this._armTimer();
  }

  private async _executeJob(job: CronJob): Promise<void> {
    const startMs = nowMs();
    logger.info({ name: job.name, id: job.id }, "Cron: executing job");

    let status: CronStatus = "ok";
    let errorMsg: string | null = null;

    try {
      if (this.onJob) await this.onJob(job);
    } catch (err) {
      status = "error";
      errorMsg = String(err);
      logger.error({ err, name: job.name }, "Cron: job failed");
    }

    const endMs = nowMs();
    job.state.lastStatus = status;
    job.state.lastError = errorMsg;
    job.state.lastRunAtMs = startMs;
    job.updatedAtMs = endMs;

    job.state.runHistory.push({
      runAtMs: startMs,
      status,
      durationMs: endMs - startMs,
      error: errorMsg,
    });
    // Keep only last N records — in-place splice avoids realloc
    if (job.state.runHistory.length > MAX_RUN_HISTORY) {
      job.state.runHistory.splice(0, job.state.runHistory.length - MAX_RUN_HISTORY);
    }

    // One-shot jobs
    if (job.schedule.kind === "at") {
      if (job.deleteAfterRun) {
        if (!this.store) return;
        this.store.jobs = this.store.jobs.filter((j) => j.id !== job.id);
      } else {
        job.enabled = false;
        job.state.nextRunAtMs = null;
      }
    } else {
      job.state.nextRunAtMs = computeNextRun(job.schedule, nowMs());
    }
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function _validateScheduleForAdd(schedule: CronSchedule): void {
  if (schedule.tz && schedule.kind !== "cron") {
    throw new Error("tz can only be used with cron schedules");
  }
  if (schedule.kind === "cron" && schedule.tz) {
    const err = validateTimezone(schedule.tz);
    if (err) throw new Error(err);
  }
}
