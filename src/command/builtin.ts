
import type { OutboundMessage } from "../bus/events.js";
import type { CommandContext } from "./router.js";
import { CommandRouter } from "./router.js";

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function cmdStop(ctx: CommandContext): Promise<OutboundMessage> {
  const loop = ctx.loop;
  const msg = ctx.msg;
  let cancelled = 0;

  if (loop) {
    const tasks = loop.activeTasks.get(msg.sessionKeyOverride ?? `${msg.channel}:${msg.chatId}`) ?? [];
    for (const task of tasks) {
      if (!task.done && task.cancel()) cancelled++;
    }
  }

  return {
    channel: msg.channel,
    chatId: msg.chatId,
    content: cancelled > 0 ? `Stopped ${cancelled} task(s).` : "No active task to stop.",
  };
}

async function cmdRestart(ctx: CommandContext): Promise<OutboundMessage> {
  const msg = ctx.msg;
  // Defer restart so the response can be sent first
  setTimeout(() => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit" });
    process.exit(0);
  }, 500);
  return { channel: msg.channel, chatId: msg.chatId, content: "Restarting..." };
}

async function cmdNew(ctx: CommandContext): Promise<OutboundMessage> {
  const msg = ctx.msg;
  const loop = ctx.loop;

  if (loop) {
    const session = ctx.session ?? loop.sessions.getOrCreate(ctx.key);
    const snapshot = session.messages.slice(session.lastConsolidated);
    session.clear();
    // Await the write before invalidating the cache — otherwise a concurrent
    // getOrCreate() could reload the pre-clear file from disk in the gap.
    await loop.sessions.save(session);
    loop.sessions.invalidate(session.key);
    if (snapshot.length) {
      // Archive snapshot in background — fire and forget
      loop.scheduleBackground(Promise.resolve());
    }
  }

  return { channel: msg.channel, chatId: msg.chatId, content: "New session started." };
}

async function cmdStatus(ctx: CommandContext): Promise<OutboundMessage> {
  const msg = ctx.msg;
  const loop = ctx.loop;

  let model = loop?.model ?? "unknown";
  let ctxTokens = loop?.contextWindowTokens ?? 0;
  let lastUsage = loop?.lastUsage ?? {};
  let sessionMsgs = 0;

  if (loop) {
    const session = ctx.session ?? loop.sessions.getOrCreate(ctx.key);
    sessionMsgs = session.getHistory(0).length;
  }

  const uptime = loop
    ? Math.floor((Date.now() / 1000 - loop.startTime))
    : 0;
  const uptimeStr =
    uptime < 60
      ? `${uptime}s`
      : uptime < 3600
        ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
        : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  const lines = [
    `nanobot v${VERSION}`,
    `Model: ${model}`,
    `Uptime: ${uptimeStr}`,
    `Context window: ${ctxTokens ? ctxTokens.toLocaleString() + " tokens" : "default"}`,
    `Session messages: ${sessionMsgs}`,
  ];

  if (lastUsage["prompt_tokens"]) {
    lines.push(
      `Last call: ${lastUsage["prompt_tokens"]} prompt / ` +
        `${lastUsage["completion_tokens"] ?? 0} completion tokens`,
    );
    if (lastUsage["cached_tokens"]) {
      lines.push(`  Cached: ${lastUsage["cached_tokens"]} tokens`);
    }
  }

  return {
    channel: msg.channel,
    chatId: msg.chatId,
    content: lines.join("\n"),
    metadata: { renderAs: "text" },
  };
}

async function cmdHelp(ctx: CommandContext): Promise<OutboundMessage> {
  return {
    channel: ctx.msg.channel,
    chatId: ctx.msg.chatId,
    content: buildHelpText(),
    metadata: { renderAs: "text" },
  };
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function buildHelpText(): string {
  return [
    "🐈 nanobot commands:",
    "/new     — Start a new conversation",
    "/stop    — Stop the current task",
    "/restart — Restart the bot",
    "/status  — Show bot status",
    "/help    — Show available commands",
  ].join("\n");
}

export function registerBuiltinCommands(router: CommandRouter): void {
  router.priority("/stop", cmdStop);
  router.priority("/restart", cmdRestart);
  router.priority("/status", cmdStatus);
  router.exact("/new", cmdNew);
  router.exact("/status", cmdStatus);
  router.exact("/help", cmdHelp);
}
