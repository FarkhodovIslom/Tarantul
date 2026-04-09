/**
 * CronTool — LLM-facing tool that wraps CronService.
 * Mirrors nanobot/agent/tools/cron.py
 */

import { Tool } from "./base.js";
import type { CronService } from "../../cron/service.js";
import { type CronSchedule, validateTimezone } from "../../cron/types.js";

export class CronTool extends Tool {
  private channel = "";
  private chatId = "";
  /** True when executing inside a cron callback (prevents recursive scheduling). */
  private inCronContext = false;

  readonly defaultTimezone: string;

  constructor(
    private readonly cron: CronService,
    defaultTimezone = "UTC",
  ) {
    super();
    this.defaultTimezone = defaultTimezone;
  }

  /** Called by AgentLoop before each tool execution to inject routing context. */
  setContext(channel: string, chatId: string): void {
    this.channel = channel;
    this.chatId = chatId;
  }

  /** Mark/unmark that we are running inside a cron job callback. */
  setCronContext(active: boolean): void {
    this.inCronContext = active;
  }

  // ---------------------------------------------------------------------------
  // Tool interface
  // ---------------------------------------------------------------------------

  override readonly name = "cron";

  override get description(): string {
    return (
      "Schedule reminders and recurring tasks. Actions: add, list, remove. " +
      `If tz is omitted, cron expressions and naive ISO times default to ${this.defaultTimezone}.`
    );
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "list", "remove"],
          description: "Action to perform",
        },
        message: {
          type: "string",
          description:
            "Instruction for the agent to execute when the job triggers " +
            "(e.g., 'Send a reminder to the user' or 'Check system status and report')",
        },
        every_seconds: {
          type: "integer",
          description: "Interval in seconds (for recurring tasks)",
        },
        cron_expr: {
          type: "string",
          description: "Cron expression like '0 9 * * *' (for scheduled tasks)",
        },
        tz: {
          type: "string",
          description:
            `Optional IANA timezone for cron expressions (e.g. 'America/Vancouver'). ` +
            `Defaults to ${this.defaultTimezone}.`,
        },
        at: {
          type: "string",
          description:
            `ISO datetime for one-time execution (e.g. '2026-02-12T10:30:00'). ` +
            `Naive values default to ${this.defaultTimezone}.`,
        },
        deliver: {
          type: "boolean",
          description: "Whether to deliver the execution result to the user channel (default true)",
        },
        job_id: {
          type: "string",
          description: "Job ID (for remove)",
        },
      },
      required: ["action"],
    };
  }

  override async execute(params: Record<string, unknown>): Promise<string> {
    const action = params["action"] as string;
    switch (action) {
      case "add":
        return this._addJob(params);
      case "list":
        return this._listJobs();
      case "remove":
        return this._removeJob(params["job_id"] as string | undefined);
      default:
        return `Error: unknown action '${action}'`;
    }
  }

  // ---------------------------------------------------------------------------
  // Action implementations
  // ---------------------------------------------------------------------------

  private _addJob(params: Record<string, unknown>): string {
    if (this.inCronContext) {
      return "Error: cannot schedule new jobs from within a cron job execution";
    }

    const message = (params["message"] as string | undefined) ?? "";
    if (!message) return "Error: message is required for add";
    if (!this.channel || !this.chatId) return "Error: no session context (channel/chat_id)";

    const everySeconds = params["every_seconds"] as number | undefined;
    const cronExpr = params["cron_expr"] as string | undefined;
    const tz = params["tz"] as string | undefined;
    const at = params["at"] as string | undefined;
    const deliver = (params["deliver"] as boolean | undefined) ?? true;

    if (tz && !cronExpr) return "Error: tz can only be used with cron_expr";
    if (tz) {
      const err = validateTimezone(tz);
      if (err) return `Error: ${err}`;
    }

    let schedule: CronSchedule;
    let deleteAfterRun = false;

    if (everySeconds) {
      schedule = { kind: "every", everyMs: everySeconds * 1000 };
    } else if (cronExpr) {
      const effectiveTz = tz ?? this.defaultTimezone;
      const tzErr = validateTimezone(effectiveTz);
      if (tzErr) return `Error: ${tzErr}`;
      schedule = { kind: "cron", expr: cronExpr, tz: effectiveTz };
    } else if (at) {
      let atMs: number;
      try {
        const raw = at.trim();
        // If no timezone in string, attach defaultTimezone
        const hasOffset = /[Z+\-]\d{2}:?\d{0,2}$/.test(raw) || raw.endsWith("Z");
        const isoStr = hasOffset
          ? raw
          : `${raw}[${this.defaultTimezone}]`;
        const dt = new Date(hasOffset ? raw : raw); // parse naive first
        if (isNaN(dt.getTime())) throw new Error("invalid date");

        // For naive datetimes, treat as the default timezone
        if (!hasOffset) {
          // Use Intl to get the UTC offset at that local time in the default TZ
          const tzErr2 = validateTimezone(this.defaultTimezone);
          if (tzErr2) return `Error: ${tzErr2}`;
          // Re-parse using toLocaleString trick for offset resolution
          const ref = new Date(raw + "Z"); // pretend UTC
          const tzOffset = getTimezoneOffsetMs(ref, this.defaultTimezone);
          atMs = ref.getTime() - tzOffset;
        } else {
          atMs = dt.getTime();
        }
      } catch {
        return `Error: invalid ISO datetime format '${at}'. Expected format: YYYY-MM-DDTHH:MM:SS`;
      }
      schedule = { kind: "at", atMs };
      deleteAfterRun = true;
    } else {
      return "Error: either every_seconds, cron_expr, or at is required";
    }

    try {
      const job = this.cron.addJob({
        name: message.slice(0, 30),
        schedule,
        message,
        deliver,
        channel: this.channel,
        to: this.chatId,
        deleteAfterRun,
      });
      return `Created job '${job.name}' (id: ${job.id})`;
    } catch (err) {
      return `Error: ${err}`;
    }
  }

  private _listJobs(): string {
    const jobs = this.cron.listJobs();
    if (!jobs.length) return "No scheduled jobs.";
    const lines = jobs.map((j) => {
      const timing = formatTiming(j.schedule);
      const parts = [`- ${j.name} (id: ${j.id}, ${timing})`];
      // Last run
      if (j.state.lastRunAtMs) {
        const tz = j.schedule.tz ?? this.defaultTimezone;
        const info =
          `  Last run: ${formatTimestamp(j.state.lastRunAtMs, tz)} — ` +
          `${j.state.lastStatus ?? "unknown"}` +
          (j.state.lastError ? ` (${j.state.lastError})` : "");
        parts.push(info);
      }
      // Next run
      if (j.state.nextRunAtMs) {
        const tz = j.schedule.tz ?? this.defaultTimezone;
        parts.push(`  Next run: ${formatTimestamp(j.state.nextRunAtMs, tz)}`);
      }
      return parts.join("\n");
    });
    return "Scheduled jobs:\n" + lines.join("\n");
  }

  private _removeJob(jobId: string | undefined): string {
    if (!jobId) return "Error: job_id is required for remove";
    return this.cron.removeJob(jobId)
      ? `Removed job ${jobId}`
      : `Error: job ${jobId} not found`;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ms: number, tz: string): string {
  try {
    return new Date(ms).toLocaleString("en-US", { timeZone: tz, hour12: false }) + ` (${tz})`;
  } catch {
    return new Date(ms).toISOString();
  }
}

function formatTiming(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "cron": {
      const tz = schedule.tz ? ` (${schedule.tz})` : "";
      return `cron: ${schedule.expr}${tz}`;
    }
    case "every": {
      const ms = schedule.everyMs ?? 0;
      if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
      if (ms % 60_000 === 0) return `every ${ms / 60_000}m`;
      if (ms % 1_000 === 0) return `every ${ms / 1_000}s`;
      return `every ${ms}ms`;
    }
    case "at":
      return schedule.atMs ? `at ${new Date(schedule.atMs).toISOString()}` : "at (unknown)";
  }
}

/** Get UTC offset in ms for a given datetime in a timezone. */
function getTimezoneOffsetMs(utcDate: Date, tz: string): number {
  // Format the date in the target timezone and parse back to get local time
  const localStr = utcDate.toLocaleString("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const localMs = new Date(localStr.replace(",", "")).getTime();
  return localMs - utcDate.getTime();
}
