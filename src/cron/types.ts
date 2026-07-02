export type CronScheduleKind = "at" | "every" | "cron";
export type CronPayloadKind = "system_event" | "agent_turn";
export type CronStatus = "ok" | "error" | "skipped";

export interface CronSchedule {
  kind: CronScheduleKind;
  /** "at" — Unix timestamp in ms */
  atMs?: number | null;
  /** "every" — interval in ms */
  everyMs?: number | null;
  /** "cron" — cron expression e.g. "0 9 * * *" */
  expr?: string | null;
  /** IANA timezone for cron expressions */
  tz?: string | null;
}

export interface CronPayload {
  kind: CronPayloadKind;
  message: string;
  /** Deliver agent response back to a channel */
  deliver: boolean;
  channel?: string | null;
  /** Chat ID / phone number / etc. */
  to?: string | null;
}

export interface CronRunRecord {
  runAtMs: number;
  status: CronStatus;
  durationMs: number;
  error?: string | null;
}

export interface CronJobState {
  nextRunAtMs?: number | null;
  lastRunAtMs?: number | null;
  lastStatus?: CronStatus | null;
  lastError?: string | null;
  runHistory: CronRunRecord[];
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  state: CronJobState;
  createdAtMs: number;
  updatedAtMs: number;
  deleteAfterRun: boolean;
}

export interface CronStore {
  version: number;
  jobs: CronJob[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function nowMs(): number {
  return Date.now();
}

/**
 * Compute the next run time (ms) for a schedule.
 * Returns null when the schedule is exhausted or invalid.
 */
export function computeNextRun(schedule: CronSchedule, fromMs: number): number | null {
  switch (schedule.kind) {
    case "at": {
      const t = schedule.atMs ?? null;
      return t !== null && t > fromMs ? t : null;
    }

    case "every": {
      const iv = schedule.everyMs ?? 0;
      return iv > 0 ? fromMs + iv : null;
    }

    case "cron": {
      if (!schedule.expr) return null;
      try {
        const { Cron } = require("croner") as typeof import("croner");
        const cronOpts = schedule.tz ? { timezone: schedule.tz, paused: true as const } : { paused: true as const };
        const job = new Cron(schedule.expr, cronOpts);
        const next = job.nextRun(new Date(fromMs));
        return next ? next.getTime() : null;
      } catch {
        return null;
      }
    }
  }
}

/** Validate timezone via Intl (no external dep required in Bun). */
export function validateTimezone(tz: string): string | null {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return null;
  } catch {
    return `unknown timezone '${tz}'`;
  }
}
