
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  styled, ansi, printResponse, printProgress,
  StreamRenderer, ToolStatusRenderer, toolStatusLabel,
} from "./render.js";
import { Repl, readStdin } from "./repl.js";
import { loadConfig, setConfigPath } from "../config/loader.js";
import { getWorkspacePath as getWorkspacePathFromConfig } from "../config/schema.js";
import { getCliHistoryPath } from "../config/paths.js";
import { createProvider } from "../providers/factory.js";
import { SessionManager } from "../session/manager.js";
import { ToolRegistry } from "../agent/tools/registry.js";
import { ReadFileTool, WriteFileTool, EditFileTool, ListDirTool } from "../agent/tools/filesystem.js";
import { ExecTool } from "../agent/tools/shell.js";
import { AgentRunner } from "../agent/runner.js";
import { buildMessages, SystemPromptCache } from "../agent/context.js";
import { CommandRouter, registerBuiltinCommands, buildHelpText } from "../command/index.js";
import { MemoryStore, MemoryConsolidator } from "../agent/memory.js";
import { SkillsLoader, BUILTIN_SKILLS_DIR } from "../skills/index.js";
import { getCronDir } from "../config/paths.js";
import { AgentLoop } from "../agent/loop.js";
import { MessageBus } from "../bus/queue.js";
import { CronService } from "../cron/service.js";
import { CronTool } from "../agent/tools/cron.js";

import { AgentHook } from "../agent/hook.js";
import type { AgentHookContext, ToolEvent } from "../agent/hook.js";
import type { ToolCallRequest } from "../providers/base.js";

const VERSION = "0.1.0";
const LOGO = "🕷️";

// ---------------------------------------------------------------------------
// ReplHook — REPL-only streaming + tool-status rendering
// ---------------------------------------------------------------------------

/**
 * A named hook for the interactive REPL that:
 * - streams model output token-by-token via StreamRenderer
 * - renders per-tool spinners + checkmarks via ToolStatusRenderer
 *
 * Non-streaming paths (one-shot / piped) never attach this hook, so the
 * new methods stay as no-ops outside the REPL.
 */
class ReplHook extends AgentHook {
  private readonly streamRenderer: StreamRenderer;
  private readonly toolStatus = new ToolStatusRenderer();

  constructor(renderMarkdown: boolean) {
    super();
    this.streamRenderer = new StreamRenderer(renderMarkdown);
  }

  override wantsStreaming(): boolean { return true; }

  override async onStream(_ctx: AgentHookContext, delta: string): Promise<void> {
    await this.streamRenderer.onDelta(delta);
  }

  override async onStreamEnd(_ctx: AgentHookContext, opts: { resuming: boolean }): Promise<void> {
    await this.streamRenderer.onEnd(opts);
  }

  override async onToolStart(_ctx: AgentHookContext, tc: ToolCallRequest): Promise<void> {
    // Stop the stream spinner so it doesn't overwrite the tool-status line.
    this.streamRenderer.stopSpinner();
    const label = toolStatusLabel(tc.name, tc.arguments);
    this.toolStatus.start(label.running);
  }

  override async onToolEnd(_ctx: AgentHookContext, tc: ToolCallRequest, event: ToolEvent): Promise<void> {
    const label = toolStatusLabel(tc.name, tc.arguments);
    this.toolStatus.finish(label.done, event.status === "ok");
  }

  async close(): Promise<void> {
    await this.streamRenderer.close();
  }
}

// ---------------------------------------------------------------------------
// Arg parser — minimal, no deps
// ---------------------------------------------------------------------------

interface ParsedArgs {
  flags: Map<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags.set(key, next);
        i += 2;
      } else {
        flags.set(key, true);
        i++;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags.set(key, next);
        i += 2;
      } else {
        flags.set(key, true);
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { flags, positional };
}

function flag(args: ParsedArgs, ...names: string[]): string | boolean | undefined {
  for (const name of names) {
    if (args.flags.has(name)) return args.flags.get(name);
  }
  return undefined;
}

function flagStr(args: ParsedArgs, ...names: string[]): string | undefined {
  const v = flag(args, ...names);
  return typeof v === "string" ? v : undefined;
}

function flagBool(args: ParsedArgs, ...names: string[]): boolean {
  return flag(args, ...names) !== undefined && flag(args, ...names) !== false;
}

// ---------------------------------------------------------------------------
// Config + provider bootstrap
// ---------------------------------------------------------------------------

function loadRuntimeConfig(configPath?: string, workspace?: string) {
  if (configPath) {
    const abs = resolve(configPath);
    if (!existsSync(abs)) {
      console.error(styled(`Error: config not found: ${abs}`, ansi.red));
      process.exit(1);
    }
    setConfigPath(abs);
    console.error(styled(`Using config: ${abs}`, ansi.dim));
  }
  const rawCfg = loadConfig(configPath ? resolve(configPath) : undefined);
  if (workspace) (rawCfg.agents.defaults as Record<string, unknown>)["workspace"] = workspace;
  return rawCfg;
}

// ---------------------------------------------------------------------------
// Subcommand: version
// ---------------------------------------------------------------------------

function cmdVersion(): void {
  console.log(`${LOGO} tarantul v${VERSION}`);
}

// ---------------------------------------------------------------------------
// Subcommand: onboard
// ---------------------------------------------------------------------------

async function cmdOnboard(args: ParsedArgs): Promise<void> {
  const { loadConfig: load, saveConfig, getConfigPath } = await import("../config/loader.js");

  const configPath = flagStr(args, "config", "c");
  if (configPath) {
    const abs = resolve(configPath);
    setConfigPath(abs);
  }
  const cfgPath = getConfigPath();

  if (existsSync(cfgPath)) {
    console.log(styled(`Config already exists at ${cfgPath}`, ansi.yellow));
    const cfg = load(cfgPath);
    saveConfig(cfg, cfgPath);
    console.log(styled(`✓ Config refreshed at ${cfgPath}`, ansi.green));
  } else {
    const cfg = load();
    const ws = flagStr(args, "workspace", "w");
    if (ws) (cfg.agents.defaults as Record<string, unknown>)["workspace"] = ws;
    saveConfig(cfg, cfgPath);
    console.log(styled(`✓ Created config at ${cfgPath}`, ansi.green));
  }

  const wsCfg = loadRuntimeConfig(configPath);
  const wsPath = getWorkspacePathFromConfig(wsCfg);
  if (!existsSync(wsPath)) {
    mkdirSync(wsPath, { recursive: true });
    console.log(styled(`✓ Created workspace at ${wsPath}`, ansi.green));
  }

  console.log(`\n${LOGO} tarantul is ready!`);
  console.log("\nNext steps:");
  console.log(`  1. Add your API key to ${styled(cfgPath, ansi.cyan)}`);
  console.log("     Get one at: https://openrouter.ai/keys");
  console.log(`  2. Chat: ${styled("tarantul agent", ansi.cyan)}`);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Subcommand: serve — OpenAI-compatible API server
// ---------------------------------------------------------------------------

async function cmdServe(args: ParsedArgs): Promise<void> {
  const configPath = flagStr(args, "config", "c");
  const workspace = flagStr(args, "workspace", "w");
  const hostOverride = flagStr(args, "host", "H");
  const portOverride = flagStr(args, "port", "p");
  const showLogs = flagBool(args, "logs");

  if (!showLogs) process.env["LOG_LEVEL"] = "silent";

  const cfg = loadRuntimeConfig(configPath, workspace);
  const wsPath = getWorkspacePathFromConfig(cfg);
  if (!existsSync(wsPath)) mkdirSync(wsPath, { recursive: true });

  const host = hostOverride ?? cfg.api.host;
  const port = portOverride ? parseInt(portOverride, 10) : cfg.api.port;
  const timeoutSecs = cfg.api.timeout;
  const modelName = cfg.agents.defaults.model;

  const provider = createProvider(cfg);
  const sessions = new SessionManager(wsPath);
  const tools = new ToolRegistry();
  const restrictWs = cfg.tools.restrictToWorkspace;
  const allowedDir = restrictWs ? wsPath : undefined;
  const extraRead = restrictWs ? [BUILTIN_SKILLS_DIR] : undefined;
  tools.register(new ReadFileTool(wsPath, allowedDir, extraRead));
  tools.register(new WriteFileTool(wsPath, allowedDir));
  tools.register(new EditFileTool(wsPath, allowedDir));
  tools.register(new ListDirTool(wsPath, allowedDir));
  if (cfg.tools.exec.enable) {
    tools.register(new ExecTool({
      workingDir: wsPath,
      timeout: cfg.tools.exec.timeout,
      restrictToWorkspace: restrictWs,
    }));
  }

  const bus = new MessageBus();

  // Cron service — its onJob callback is late-bound to the AgentLoop below.
  let loop: AgentLoop | null = null;
  const cron = new CronService(join(getCronDir(), "jobs.json"), (job) =>
    loop ? loop.handleCronJob(job) : Promise.resolve(null),
  );
  const cronTool = new CronTool(cron, cfg.agents.defaults.timezone);
  tools.register(cronTool);

  const runner = new AgentRunner(provider);
  const runSpec = {
    tools,
    model: modelName,
    maxIterations: cfg.agents.defaults.maxToolIterations,
    maxToolResultChars: cfg.agents.defaults.maxToolResultChars,
    temperature: cfg.agents.defaults.temperature,
    maxTokens: cfg.agents.defaults.maxTokens,
    contextWindowTokens: cfg.agents.defaults.contextWindowTokens,
  };

  // Skills + system prompt
  const skillsLoader = new SkillsLoader(wsPath);
  const memoryStore = new MemoryStore(wsPath);
  const promptCache = new SystemPromptCache(wsPath);
  const getSystemPrompt = (): string => {
    const memory = memoryStore.getMemoryContext();
    const skillsSummary = skillsLoader.buildSkillsSummary();
    const alwaysContent = skillsLoader.loadSkillsForContext(skillsLoader.getAlwaysSkills());
    return promptCache.get(memory, skillsSummary, alwaysContent, tools.toolNames);
  };

  // Memory consolidation — compresses long sessions into MEMORY.md/HISTORY.md.
  const consolidator = new MemoryConsolidator({
    workspace: wsPath,
    provider,
    model: modelName,
    sessions,
    contextWindowTokens: cfg.agents.defaults.contextWindowTokens,
    maxCompletionTokens: cfg.agents.defaults.maxTokens,
    buildMessages: (o) =>
      buildMessages({
        history: o.history,
        currentMessage: o.currentMessage,
        systemPrompt: getSystemPrompt(),
        channel: o.channel ?? null,
        chatId: o.chatId ?? null,
        timezone: cfg.agents.defaults.timezone,
      }),
    getToolDefinitions: () => tools.getDefinitions(),
  });

  // Gateway loop: bus (inbound) → AgentRunner → bus (outbound).
  loop = new AgentLoop({
    bus,
    runner,
    sessions,
    runSpec,
    getSystemPrompt,
    timezone: cfg.agents.defaults.timezone,
    cronTool,
    consolidator,
    sendProgress: cfg.channels.sendProgress,
  });

  const { startApiServer } = await import("../api/server.js");
  const server = startApiServer(
    { host, port, timeoutSecs, modelName, getSystemPrompt },
    runner, sessions, tools, runSpec,
  );

  // Channel manager (Telegram/Slack/Discord) — only started if any channel is enabled
  const { ChannelManager } = await import("../channels/manager.js");
  const channelManager = await ChannelManager.create(cfg, bus);

  console.log(`${LOGO} tarantul`);
  console.log(`  API      : ${styled(`${server.url}/v1/chat/completions`, ansi.cyan)}`);
  console.log(`  Model    : ${styled(modelName, ansi.cyan)}`);
  const chNames = channelManager.enabledChannels;
  if (chNames.length > 0) {
    console.log(`  Channels : ${styled(chNames.join(", "), ansi.cyan)}`);
  }
  if (host === "0.0.0.0" || host === "::") {
    console.log(styled("  Warning: API bound to all interfaces.", ansi.yellow));
  }
  console.log();
  console.log(styled("Press Ctrl+C to stop.", ansi.dim));

  // Start the gateway loop and cron scheduler before channels so inbound
  // messages are consumed the moment a channel delivers them.
  loop.start();
  await cron.start();

  // Start channels (non-blocking — each channel loops internally)
  const channelTask = channelManager.startAll();

  // Block until SIGINT/SIGTERM
  const shutdown = async (resolveFn: () => void): Promise<void> => {
    server.stop();
    cron.stop();
    await channelManager.stopAll();
    await loop!.stop();
    resolveFn();
  };
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => void shutdown(resolve));
    process.once("SIGTERM", () => void shutdown(resolve));
  });
  await channelTask;
}

// ---------------------------------------------------------------------------
// Subcommand: agent — interactive / one-shot chat
// ---------------------------------------------------------------------------

async function cmdAgent(args: ParsedArgs): Promise<void> {
  const configPath = flagStr(args, "config", "c");
  const workspace = flagStr(args, "workspace", "w");
  const sessionId = flagStr(args, "session", "s") ?? "cli:direct";
  const oneShot = flagStr(args, "message", "m");
  const renderMarkdown = !flagBool(args, "no-markdown");
  const showLogs = flagBool(args, "logs");

  if (!showLogs) {
    // Suppress pino output for clean CLI experience
    process.env["LOG_LEVEL"] = "silent";
  }

  const cfg = loadRuntimeConfig(configPath, workspace);
  const wsPath = getWorkspacePathFromConfig(cfg);
  if (!existsSync(wsPath)) mkdirSync(wsPath, { recursive: true });

  // Provider
  const provider = createProvider(cfg);

  // Session manager
  const sessions = new SessionManager(wsPath);

  // Tool registry
  const tools = new ToolRegistry();
  const restrictWs = cfg.tools.restrictToWorkspace;
  const allowedDir = restrictWs ? wsPath : undefined;
  const extraRead = restrictWs ? [BUILTIN_SKILLS_DIR] : undefined;
  tools.register(new ReadFileTool(wsPath, allowedDir, extraRead));
  tools.register(new WriteFileTool(wsPath, allowedDir));
  tools.register(new EditFileTool(wsPath, allowedDir));
  tools.register(new ListDirTool(wsPath, allowedDir));
  if (cfg.tools.exec.enable) {
    tools.register(new ExecTool({
      workingDir: wsPath,
      timeout: cfg.tools.exec.timeout,
      restrictToWorkspace: restrictWs,
    }));
  }

  const runner = new AgentRunner(provider);

  // Skills + system prompt cache
  const skillsLoader = new SkillsLoader(wsPath);
  const memoryStore = new MemoryStore(wsPath);
  const promptCache = new SystemPromptCache(wsPath);

  function getSystemPrompt(): string {
    const memory = memoryStore.getMemoryContext();
    const skillsSummary = skillsLoader.buildSkillsSummary();
    const alwaysSkills = skillsLoader.getAlwaysSkills();
    const alwaysContent = skillsLoader.loadSkillsForContext(alwaysSkills);
    return promptCache.get(memory, skillsSummary, alwaysContent, tools.toolNames);
  }

  // Command router for /slash commands
  const router = new CommandRouter();
  registerBuiltinCommands(router);

  // -----------------------------------------------------------------------
  // Run one turn: build messages → run → render response
  // -----------------------------------------------------------------------
  async function runTurn(userMessage: string, streaming: boolean): Promise<string | null> {
    const session = sessions.getOrCreate(sessionId);
    const history = session.getHistory(0);

    const messages = buildMessages({
      history,
      currentMessage: userMessage,
      systemPrompt: getSystemPrompt(),
      channel: "cli",
      chatId: "direct",
    });

    let replHook: ReplHook | null = null;

    const result = await runner.run({
      initialMessages: messages,
      tools,
      model: cfg.agents.defaults.model,
      maxIterations: cfg.agents.defaults.maxToolIterations,
      maxToolResultChars: cfg.agents.defaults.maxToolResultChars,
      temperature: cfg.agents.defaults.temperature,
      maxTokens: cfg.agents.defaults.maxTokens,
      contextWindowTokens: cfg.agents.defaults.contextWindowTokens,
      progressCallback: async (msg: string) => {
        if (!streaming) printProgress(msg);
      },
      ...(streaming
        ? {
            hook: (() => {
              replHook = new ReplHook(renderMarkdown);
              return replHook;
            })(),
          }
        : {}),
    });

    if (replHook) await (replHook as ReplHook).close();

    // Persist new messages to session
    const newMsgs = result.messages.slice(1 + history.length); // skip system + history
    const now = new Date().toISOString();
    // Save user + assistant messages to session
    session.messages.push(
      { role: "user", content: userMessage, timestamp: now },
      ...(result.finalContent
        ? [{ role: "assistant", content: result.finalContent, timestamp: now }]
        : []),
    );
    session.updatedAt = new Date();
    await sessions.save(session);

    return result.finalContent;
  }

  // -----------------------------------------------------------------------
  // One-shot mode: -m "message"
  // -----------------------------------------------------------------------
  if (oneShot) {
    const response = await runTurn(oneShot, false);
    if (response) printResponse(response, renderMarkdown);
    return;
  }

  // -----------------------------------------------------------------------
  // Piped input (non-TTY stdin)
  // -----------------------------------------------------------------------
  if (!process.stdin.isTTY) {
    const input = await readStdin();
    if (input) {
      const response = await runTurn(input, false);
      if (response) printResponse(response, renderMarkdown);
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Interactive REPL
  // -----------------------------------------------------------------------
  const historyPath = getCliHistoryPath();
  const repl = new Repl(historyPath);
  repl.start();

  console.log(
    `${LOGO} ${styled("tarantul", ansi.cyan)} v${VERSION} — ` +
      `model: ${styled(cfg.agents.defaults.model, ansi.cyan)}`,
  );
  console.log(styled('Type "/help" for commands, "exit" to quit.', ansi.dim));
  console.log();

  const streaming = process.stdout.isTTY;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let line: string | null;
    try {
      line = await repl.readLine();
    } catch {
      break;
    }
    if (line === null) break; // EOF
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (repl.isExit(trimmed)) break;

    // Slash commands
    if (trimmed.startsWith("/")) {
      const dummyMsg = {
        channel: "cli",
        senderId: "user",
        chatId: "direct",
        content: trimmed,
      };
      if (router.isPriority(trimmed)) {
        const resp = await router.dispatchPriority({
          msg: dummyMsg,
          session: sessions.getOrCreate(sessionId),
          key: sessionId,
          raw: trimmed,
          args: "",
          loop: null,
        });
        if (resp) printResponse(resp.content, false, true);
        continue;
      }
      const resp = await router.dispatch({
        msg: dummyMsg,
        session: sessions.getOrCreate(sessionId),
        key: sessionId,
        raw: trimmed,
        args: "",
        loop: null,
      });
      if (resp) {
        const asText = (resp.metadata?.["renderAs"] === "text");
        printResponse(resp.content, renderMarkdown && !asText, asText);
        continue;
      }
    }

    // Normal message
    try {
      const response = await runTurn(trimmed, streaming);
      if (response && !streaming) {
        printResponse(response, renderMarkdown);
      }
    } catch (err) {
      console.error(styled(`Error: ${err}`, ansi.red));
    }
  }

  repl.close();
  console.log(styled("Goodbye!", ansi.dim));
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const subcmd = argv[0];
  const rest = argv.slice(1);

  if (!subcmd || subcmd === "--help" || subcmd === "-h") {
    console.log(`${LOGO} tarantul v${VERSION} — Personal AI Assistant`);
    console.log();
    console.log("Usage: tarantul <command> [options]");
    console.log();
    console.log("Commands:");
    console.log("  agent    Interactive chat with the agent");
    console.log("  onboard  Initialize configuration and workspace");
    console.log("  serve    Start OpenAI-compatible API server");
    console.log("  version  Print version");
    console.log();
    console.log("Run 'tarantul <command> --help' for command options.");
    return;
  }

  if (subcmd === "version" || subcmd === "--version" || subcmd === "-v") {
    cmdVersion();
    return;
  }

  const args = parseArgs(rest);

  if (flagBool(args, "help", "h")) {
    // Per-command help
    switch (subcmd) {
      case "agent":
        console.log("Usage: tarantul agent [options]");
        console.log("  -m, --message <text>    One-shot message (non-interactive)");
        console.log("  -s, --session <key>     Session key (default: cli:direct)");
        console.log("  -w, --workspace <path>  Workspace directory");
        console.log("  -c, --config <path>     Config file path");
        console.log("  --no-markdown           Disable markdown rendering");
        console.log("  --logs                  Show runtime logs");
        break;
      case "onboard":
        console.log("Usage: tarantul onboard [options]");
        console.log("  -w, --workspace <path>  Workspace directory");
        console.log("  -c, --config <path>     Config file path");
        break;
      case "serve":
        console.log("Usage: tarantul serve [options]");
        console.log("  -p, --port <port>       Port (default: 8080)");
        console.log("  -H, --host <host>       Bind address (default: 127.0.0.1)");
        console.log("  -c, --config <path>     Config file path");
        break;
    }
    return;
  }

  switch (subcmd) {
    case "agent":
      await cmdAgent(args);
      break;
    case "onboard":
      await cmdOnboard(args);
      break;
    case "serve":
      await cmdServe(args);
      break;
    default:
      console.error(styled(`Unknown command: ${subcmd}`, ansi.red));
      console.error("Run 'tarantul --help' for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(styled(`Fatal: ${err}`, ansi.red));
  process.exit(1);
});
