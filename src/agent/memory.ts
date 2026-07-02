import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { LLMProvider } from "../providers/base.js";
import { hasToolCalls } from "../providers/base.js";
import type { Session, SessionManager } from "../session/manager.js";
import { estimateMessageTokens } from "../utils/tokens.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// save_memory tool definition (sent to LLM once per consolidation call)
// ---------------------------------------------------------------------------

const SAVE_MEMORY_TOOL: Record<string, unknown>[] = [
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save the memory consolidation result to persistent storage.",
      parameters: {
        type: "object",
        properties: {
          history_entry: {
            type: "string",
            description:
              "A paragraph summarizing key events/decisions/topics. " +
              "Start with [YYYY-MM-DD HH:MM]. Include detail useful for grep search.",
          },
          memory_update: {
            type: "string",
            description:
              "Full updated long-term memory as markdown. Include all existing " +
              "facts plus new ones. Return unchanged if nothing new.",
          },
        },
        required: ["history_entry", "memory_update"],
      },
    },
  },
];

const TOOL_CHOICE_ERROR_MARKERS = ["tool_choice", "toolchoice", "does not support"];

function isToolChoiceUnsupported(content: string | null): boolean {
  const text = (content ?? "").toLowerCase();
  return TOOL_CHOICE_ERROR_MARKERS.some((m) => text.includes(m));
}

function normalizeArgs(
  args: unknown,
): { historyEntry: string; memoryUpdate: string } | null {
  let obj: Record<string, unknown> | null = null;
  if (typeof args === "string") {
    try { obj = JSON.parse(args) as Record<string, unknown>; } catch { return null; }
  } else if (Array.isArray(args)) {
    obj = (args[0] as Record<string, unknown> | undefined) ?? null;
  } else if (typeof args === "object" && args !== null) {
    obj = args as Record<string, unknown>;
  }
  if (!obj) return null;

  // Support both camelCase and snake_case
  const historyEntry = (obj["history_entry"] ?? obj["historyEntry"]) as string | undefined;
  const memoryUpdate = (obj["memory_update"] ?? obj["memoryUpdate"]) as string | undefined;
  if (!historyEntry || !memoryUpdate) return null;

  return {
    historyEntry: typeof historyEntry === "string" ? historyEntry : JSON.stringify(historyEntry),
    memoryUpdate: typeof memoryUpdate === "string" ? memoryUpdate : JSON.stringify(memoryUpdate),
  };
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  private readonly memoryFile: string;
  private readonly historyFile: string;
  private consecutiveFailures = 0;

  private static readonly MAX_FAILURES_BEFORE_RAW_ARCHIVE = 3;

  constructor(workspace: string) {
    const dir = join(workspace, "memory");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.memoryFile = join(dir, "MEMORY.md");
    this.historyFile = join(dir, "HISTORY.md");
  }

  readLongTerm(): string {
    return existsSync(this.memoryFile) ? readFileSync(this.memoryFile, "utf-8") : "";
  }

  writeLongTerm(content: string): void {
    writeFileSync(this.memoryFile, content, "utf-8");
  }

  appendHistory(entry: string): void {
    appendFileSync(this.historyFile, entry.trimEnd() + "\n\n", "utf-8");
  }

  getMemoryContext(): string {
    const lt = this.readLongTerm();
    return lt ? `## Long-term Memory\n${lt}` : "";
  }

  private static formatMessages(messages: Record<string, unknown>[]): string {
    return messages
      .filter((m) => m["content"])
      .map((m) => {
        const ts = ((m["timestamp"] as string | undefined) ?? "?").slice(0, 16);
        const role = ((m["role"] as string | undefined) ?? "?").toUpperCase();
        return `[${ts}] ${role}: ${m["content"]}`;
      })
      .join("\n");
  }

  async consolidate(
    messages: Record<string, unknown>[],
    provider: LLMProvider,
    model: string,
  ): Promise<boolean> {
    if (!messages.length) return true;

    const currentMemory = this.readLongTerm();
    const prompt =
      `Process this conversation and call the save_memory tool with your consolidation.\n\n` +
      `## Current Long-term Memory\n${currentMemory || "(empty)"}\n\n` +
      `## Conversation to Process\n${MemoryStore.formatMessages(messages)}`;

    const chatMessages: Record<string, unknown>[] = [
      {
        role: "system",
        content:
          "You are a memory consolidation agent. " +
          "Call the save_memory tool with your consolidation of the conversation.",
      },
      { role: "user", content: prompt },
    ];

    try {
      let response = await provider.chatWithRetry({
        messages: chatMessages,
        tools: SAVE_MEMORY_TOOL,
        model,
        toolChoice: { type: "function", function: { name: "save_memory" } },
      });

      // Some providers don't support forced tool_choice — retry with "auto"
      if (response.finishReason === "error" && isToolChoiceUnsupported(response.content)) {
        logger.warn("Memory consolidation: forced tool_choice unsupported, retrying with auto");
        response = await provider.chatWithRetry({
          messages: chatMessages,
          tools: SAVE_MEMORY_TOOL,
          model,
          toolChoice: "auto",
        });
      }

      if (!hasToolCalls(response)) {
        logger.warn(
          { finishReason: response.finishReason },
          "Memory consolidation: LLM did not call save_memory",
        );
        return this._failOrRawArchive(messages);
      }

      const parsed = normalizeArgs(response.toolCalls[0]!.arguments);
      if (!parsed) {
        logger.warn("Memory consolidation: unexpected save_memory arguments");
        return this._failOrRawArchive(messages);
      }

      const entry = parsed.historyEntry.trim();
      if (!entry) {
        logger.warn("Memory consolidation: history_entry is empty");
        return this._failOrRawArchive(messages);
      }

      this.appendHistory(entry);
      if (parsed.memoryUpdate !== currentMemory) {
        this.writeLongTerm(parsed.memoryUpdate);
      }

      this.consecutiveFailures = 0;
      logger.info({ count: messages.length }, "Memory consolidation done");
      return true;
    } catch (err) {
      logger.error({ err }, "Memory consolidation failed");
      return this._failOrRawArchive(messages);
    }
  }

  private _failOrRawArchive(messages: Record<string, unknown>[]): boolean {
    this.consecutiveFailures++;
    if (this.consecutiveFailures < MemoryStore.MAX_FAILURES_BEFORE_RAW_ARCHIVE) return false;
    this._rawArchive(messages);
    this.consecutiveFailures = 0;
    return true;
  }

  private _rawArchive(messages: Record<string, unknown>[]): void {
    const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
    const formatted = MemoryStore["formatMessages"](messages);
    this.appendHistory(`[${ts}] [RAW] ${messages.length} messages\n${formatted}`);
    logger.warn({ count: messages.length }, "Memory: raw-archived after repeated failures");
  }
}

// ---------------------------------------------------------------------------
// MemoryConsolidator
// ---------------------------------------------------------------------------

export interface ConsolidatorOptions {
  workspace: string;
  provider: LLMProvider;
  model: string;
  sessions: SessionManager;
  contextWindowTokens: number;
  buildMessages: (opts: {
    history: Record<string, unknown>[];
    currentMessage: string;
    channel?: string | null;
    chatId?: string | null;
  }) => Record<string, unknown>[];
  getToolDefinitions: () => unknown[];
  maxCompletionTokens?: number;
}

export class MemoryConsolidator {
  readonly store: MemoryStore;
  private readonly provider: LLMProvider;
  private readonly model: string;
  private readonly sessions: SessionManager;
  private readonly contextWindowTokens: number;
  private readonly maxCompletionTokens: number;
  private readonly buildMessages: ConsolidatorOptions["buildMessages"];
  private readonly getToolDefinitions: ConsolidatorOptions["getToolDefinitions"];
  /**
   * Per-session consolidation lock, keyed by session key. Each call chains
   * onto the previous one so consolidations for the same session never run
   * concurrently. Entries are deleted once their promise settles (see
   * `maybeConsolidateByTokens`) so this map doesn't grow forever — a plain
   * Map with explicit cleanup, rather than WeakRef, so removal doesn't
   * depend on GC timing.
   */
  private readonly locks = new Map<string, Promise<void>>();

  private static readonly MAX_CONSOLIDATION_ROUNDS = 5;
  private static readonly SAFETY_BUFFER = 1024;

  constructor(opts: ConsolidatorOptions) {
    this.store = new MemoryStore(opts.workspace);
    this.provider = opts.provider;
    this.model = opts.model;
    this.sessions = opts.sessions;
    this.contextWindowTokens = opts.contextWindowTokens;
    this.maxCompletionTokens = opts.maxCompletionTokens ?? 4096;
    this.buildMessages = opts.buildMessages;
    this.getToolDefinitions = opts.getToolDefinitions;
  }

  // ---------------------------------------------------------------------------
  // Token estimation
  // ---------------------------------------------------------------------------

  estimateSessionPromptTokens(session: Session): number {
    const history = session.getHistory(0);
    const [channel, chatId] = session.key.includes(":")
      ? session.key.split(":", 2) as [string, string]
      : [null, null];
    const probeMessages = this.buildMessages({
      history,
      currentMessage: "[token-probe]",
      channel,
      chatId,
    });
    // Simple token estimate: sum message tokens + tool JSON estimate
    const msgTokens = probeMessages.reduce(
      (sum, m) => sum + estimateMessageTokens(m as Record<string, unknown>),
      0,
    );
    const toolTokens = Math.ceil(JSON.stringify(this.getToolDefinitions()).length / 4);
    return msgTokens + toolTokens;
  }

  // ---------------------------------------------------------------------------
  // Consolidation boundary picking
  // ---------------------------------------------------------------------------

  pickConsolidationBoundary(
    session: Session,
    tokensToRemove: number,
  ): { endIdx: number; removedTokens: number } | null {
    const start = session.lastConsolidated;
    if (start >= session.messages.length || tokensToRemove <= 0) return null;

    let removedTokens = 0;
    let lastBoundary: { endIdx: number; removedTokens: number } | null = null;

    for (let idx = start; idx < session.messages.length; idx++) {
      const msg = session.messages[idx]!;
      if (idx > start && msg["role"] === "user") {
        lastBoundary = { endIdx: idx, removedTokens };
        if (removedTokens >= tokensToRemove) return lastBoundary;
      }
      removedTokens += estimateMessageTokens(msg);
    }

    return lastBoundary;
  }

  // ---------------------------------------------------------------------------
  // Main consolidation loop
  // ---------------------------------------------------------------------------

  async maybeConsolidateByTokens(session: Session): Promise<void> {
    if (!session.messages.length || this.contextWindowTokens <= 0) return;

    // Serialize consolidation per session key: chain onto whatever is
    // currently running for this key (if anything), so at most one
    // consolidation round is ever in flight per session.
    const lockKey = session.key;
    const previous = this.locks.get(lockKey) ?? Promise.resolve();

    // A prior round's failure shouldn't block this one from running.
    const current = previous.catch(() => {}).then(() => this._doConsolidate(session));
    this.locks.set(lockKey, current);

    try {
      await current;
    } finally {
      // Only clear the slot if nothing newer has queued behind us.
      if (this.locks.get(lockKey) === current) this.locks.delete(lockKey);
    }
  }

  private async _doConsolidate(session: Session): Promise<void> {
    const budget =
      this.contextWindowTokens - this.maxCompletionTokens - MemoryConsolidator.SAFETY_BUFFER;
    const target = Math.floor(budget / 2);

    let estimated = this.estimateSessionPromptTokens(session);
    if (estimated <= 0 || estimated < budget) return;

    for (let round = 0; round < MemoryConsolidator.MAX_CONSOLIDATION_ROUNDS; round++) {
      if (estimated <= target) return;

      const boundary = this.pickConsolidationBoundary(session, Math.max(1, estimated - target));
      if (!boundary) return;

      const chunk = session.messages.slice(session.lastConsolidated, boundary.endIdx);
      if (!chunk.length) return;

      logger.info(
        { round, key: session.key, estimated, total: this.contextWindowTokens, chunk: chunk.length },
        "Memory consolidation round",
      );

      const ok = await this.store.consolidate(chunk, this.provider, this.model);
      if (!ok) return;

      session.lastConsolidated = boundary.endIdx;
      await this.sessions.save(session);

      estimated = this.estimateSessionPromptTokens(session);
      if (estimated <= 0) return;
    }
  }
}
