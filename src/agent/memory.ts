import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { LLMProvider } from "../providers/base.js";
import { hasToolCalls } from "../providers/base.js";
import type { Session, SessionManager } from "../session/manager.js";
import { estimateMessageTokens } from "../utils/tokens.js";
import { safeFilename } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

/**
 * Map a session key (`channel:chatId`) to a filesystem-safe subdirectory name.
 * A falsy key selects the shared/global memory directory (`memory/`) so the
 * default `new MemoryStore(ws)` keeps its original single-file layout.
 */
function memoryDir(workspace: string, key?: string | null): string {
  const base = join(workspace, "memory");
  return key ? join(base, safeFilename(key.replace(/:/g, "_"))) : base;
}

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
              "Full updated long-term memory (MEMORY.md) as markdown — the curated index " +
              "of durable facts. Include all existing facts plus new ones, and reference " +
              "atomic notes with [[Note Name]] wikilinks. Return unchanged if nothing new.",
          },
          notes: {
            type: "array",
            description:
              "Atomic notes to create/update — one per distinct person, project, place, " +
              "or recurring topic worth remembering. Connect related notes to each other " +
              "with [[Other Note]] wikilinks inside the content so the memory forms a graph.",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Note title, e.g. 'Project Apollo' or 'Alice'.",
                },
                content: {
                  type: "string",
                  description: "Markdown body. Use [[wikilinks]] to reference related notes.",
                },
                mode: {
                  type: "string",
                  enum: ["replace", "append"],
                  description: "'replace' (default) rewrites the note; 'append' adds to it.",
                },
              },
              required: ["name", "content"],
            },
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

interface ParsedNote {
  name: string;
  content: string;
  append: boolean;
}

function parseNotes(raw: unknown): ParsedNote[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedNote[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const name = rec["name"];
    const content = rec["content"];
    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof content !== "string" ||
      !content.trim()
    ) {
      continue;
    }
    out.push({ name: name.trim(), content, append: rec["mode"] === "append" });
  }
  return out;
}

function normalizeArgs(
  args: unknown,
): { historyEntry: string; memoryUpdate: string; notes: ParsedNote[] } | null {
  let obj: Record<string, unknown> | null = null;
  if (typeof args === "string") {
    try {
      obj = JSON.parse(args) as Record<string, unknown>;
    } catch {
      return null;
    }
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
    notes: parseNotes(obj["notes"]),
  };
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  /** Absolute path to this store's memory directory (holds MEMORY.md + logs). */
  readonly dir: string;
  private readonly memoryFile: string;
  private readonly historyFile: string;
  private consecutiveFailures = 0;

  private static readonly MAX_FAILURES_BEFORE_RAW_ARCHIVE = 3;
  /** Below this size a MEMORY.md rewrite may legitimately shrink a lot. */
  private static readonly MEMORY_GUARD_MIN_CHARS = 500;

  /**
   * @param workspace workspace root.
   * @param key optional session key (`channel:chatId`). When provided, memory
   *   is isolated under `memory/<safe-key>/` so distinct chats/channels never
   *   share long-term memory. Omit for the shared global store.
   */
  constructor(workspace: string, key?: string | null) {
    this.dir = memoryDir(workspace, key);
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.memoryFile = join(this.dir, "MEMORY.md");
    this.historyFile = join(this.dir, "HISTORY.md");
  }

  readLongTerm(): string {
    return existsSync(this.memoryFile) ? readFileSync(this.memoryFile, "utf-8") : "";
  }

  writeLongTerm(content: string): void {
    // Keep one rotating backup of the previous version so a bad full rewrite
    // (e.g. an LLM returning a truncated MEMORY.md) is always recoverable.
    // `.bak` is not a `.md` file, so the search index never picks it up.
    if (existsSync(this.memoryFile)) {
      try {
        copyFileSync(this.memoryFile, `${this.memoryFile}.bak`);
      } catch {
        /* backup is best-effort */
      }
    }
    writeFileSync(this.memoryFile, content, "utf-8");
  }

  /** Legacy single-file history log. Retained for back-compat; new writes go to daily logs. */
  appendHistory(entry: string): void {
    appendFileSync(this.historyFile, entry.trimEnd() + "\n\n", "utf-8");
  }

  /** Path to the append-only daily log for a given date (defaults to today). */
  dailyLogPath(date: Date = new Date()): string {
    return join(this.dir, `${MemoryStore.dateStamp(date)}.md`);
  }

  /** Append a running note to today's append-only daily log (memory/YYYY-MM-DD.md). */
  appendDaily(entry: string, date: Date = new Date()): void {
    appendFileSync(this.dailyLogPath(date), entry.trimEnd() + "\n\n", "utf-8");
  }

  private readDaily(date: Date): string {
    const p = this.dailyLogPath(date);
    return existsSync(p) ? readFileSync(p, "utf-8").trim() : "";
  }

  /** Directory holding atomic, wikilink-connected notes (`notes/<Name>.md`). */
  get notesDir(): string {
    return join(this.dir, "notes");
  }

  /**
   * Filesystem path for a named note. `name` may include or omit `.md`. Path
   * separators and `..` are neutralized so a note always stays inside `notes/`.
   */
  notePath(name: string): string {
    const bare = name.replace(/\.md$/i, "");
    const safe =
      bare
        .replace(/[/\\]+/g, "-")
        .replace(/\.\.+/g, ".")
        .replace(/^\.+/, "")
        .trim() || "untitled";
    return join(this.notesDir, `${safe}.md`);
  }

  /** Write (or append to) an atomic note; creates `notes/` on first use. */
  writeNote(name: string, content: string, append = false): void {
    if (!existsSync(this.notesDir)) mkdirSync(this.notesDir, { recursive: true });
    const p = this.notePath(name);
    if (append) appendFileSync(p, content.trimEnd() + "\n\n", "utf-8");
    else writeFileSync(p, content, "utf-8");
  }

  readNote(name: string): string {
    const p = this.notePath(name);
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  /** Names (without `.md`) of existing atomic notes, for consolidation context. */
  listNoteNames(): string[] {
    if (!existsSync(this.notesDir)) return [];
    try {
      return readdirSync(this.notesDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/i, ""));
    } catch {
      return [];
    }
  }

  private static dateStamp(date: Date): string {
    return date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  }

  /**
   * System-prompt memory context: curated long-term memory plus the tail of the
   * daily logs (today + yesterday), so each session starts with recent context.
   * Older context is reachable on demand via the memory_search tool.
   */
  getMemoryContext(): string {
    const parts: string[] = [];
    const lt = this.readLongTerm();
    if (lt.trim()) parts.push(`## Long-term Memory\n${lt.trim()}`);

    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    const recent = [
      { label: MemoryStore.dateStamp(yesterday), body: this.readDaily(yesterday) },
      { label: MemoryStore.dateStamp(today), body: this.readDaily(today) },
    ].filter((d) => d.body);
    if (recent.length) {
      const logs = recent.map((d) => `### ${d.label}\n${d.body}`).join("\n\n");
      parts.push(`## Recent Daily Log\n${logs}`);
    }
    return parts.join("\n\n");
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
    const existingNotes = this.listNoteNames();
    const prompt =
      `Process this conversation and call the save_memory tool with your consolidation.\n\n` +
      `## Current Long-term Memory (MEMORY.md)\n${currentMemory || "(empty)"}\n\n` +
      `## Existing Notes\n${existingNotes.length ? existingNotes.map((n) => `[[${n}]]`).join(", ") : "(none)"}\n\n` +
      `## Conversation to Process\n${MemoryStore.formatMessages(messages)}`;

    const chatMessages: Record<string, unknown>[] = [
      {
        role: "system",
        content:
          "You are a memory consolidation agent building an Obsidian-style knowledge graph. " +
          "Distill durable, reusable knowledge from the conversation and call the save_memory tool:\n" +
          "- history_entry: a timestamped paragraph for today's daily log.\n" +
          "- notes: one atomic note per distinct person, project, place, or recurring topic. " +
          "Reuse existing note names when they apply, and connect related notes with [[Other Note]] " +
          "wikilinks inside each note's content.\n" +
          "- memory_update: the curated MEMORY.md index of the most important durable facts, " +
          "referencing notes with [[Note Name]].\n" +
          "Do not invent facts. Prefer linking over duplicating.",
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

      this.appendDaily(entry);
      if (parsed.memoryUpdate !== currentMemory) {
        if (MemoryStore.looksTruncated(currentMemory, parsed.memoryUpdate)) {
          logger.warn(
            { before: currentMemory.length, after: parsed.memoryUpdate.length },
            "Memory consolidation: memory_update suspiciously short; keeping existing MEMORY.md",
          );
        } else {
          this.writeLongTerm(parsed.memoryUpdate);
        }
      }
      for (const note of parsed.notes) {
        try {
          this.writeNote(note.name, note.content, note.append);
        } catch (err) {
          logger.warn({ err, note: note.name }, "Memory consolidation: failed to write note");
        }
      }

      this.consecutiveFailures = 0;
      logger.info(
        { count: messages.length, notes: parsed.notes.length },
        "Memory consolidation done",
      );
      return true;
    } catch (err) {
      logger.error({ err }, "Memory consolidation failed");
      return this._failOrRawArchive(messages);
    }
  }

  /**
   * True when a proposed MEMORY.md rewrite lost more than half of a
   * non-trivial file — the signature of a model returning a truncated or
   * placeholder "update" (e.g. "(unchanged)") instead of the full curated
   * index it was asked for. Small files are exempt: legitimate rewrites can
   * shrink those substantially.
   */
  private static looksTruncated(current: string, updated: string): boolean {
    const cur = current.trim().length;
    if (cur < MemoryStore.MEMORY_GUARD_MIN_CHARS) return false;
    return updated.trim().length < cur / 2;
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
    this.appendDaily(`[${ts}] [RAW] ${messages.length} messages\n${formatted}`);
    logger.warn({ count: messages.length }, "Memory: raw-archived after repeated failures");
  }
}

// ---------------------------------------------------------------------------
// MemoryStoreRegistry — one MemoryStore per session key, created on demand
// ---------------------------------------------------------------------------

/**
 * Resolves (and caches) a per-session `MemoryStore`. Long-term memory is scoped
 * by session key so a fact consolidated from one chat/channel never leaks into
 * another chat's system prompt. A falsy key resolves to the shared global store.
 */
export class MemoryStoreRegistry {
  private readonly stores = new Map<string, MemoryStore>();

  constructor(private readonly workspace: string) {}

  for(key?: string | null): MemoryStore {
    const cacheKey = key ?? "";
    let store = this.stores.get(cacheKey);
    if (!store) {
      store = new MemoryStore(this.workspace, key);
      this.stores.set(cacheKey, store);
    }
    return store;
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
    /** Session key, so the token-probe prompt uses this session's memory. */
    key?: string | null;
  }) => Record<string, unknown>[];
  getToolDefinitions: () => unknown[];
  maxCompletionTokens?: number;
  /** Invoked after a session's memory changed, so the search index can refresh. */
  onConsolidated?: (key: string) => Promise<void> | void;
}

export class MemoryConsolidator {
  /** Per-session long-term memory stores (isolated by session key). */
  readonly stores: MemoryStoreRegistry;
  private readonly provider: LLMProvider;
  private readonly model: string;
  private readonly sessions: SessionManager;
  private readonly contextWindowTokens: number;
  private readonly maxCompletionTokens: number;
  private readonly buildMessages: ConsolidatorOptions["buildMessages"];
  private readonly getToolDefinitions: ConsolidatorOptions["getToolDefinitions"];
  private readonly onConsolidated: ConsolidatorOptions["onConsolidated"];
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
    this.stores = new MemoryStoreRegistry(opts.workspace);
    this.provider = opts.provider;
    this.model = opts.model;
    this.sessions = opts.sessions;
    this.contextWindowTokens = opts.contextWindowTokens;
    this.maxCompletionTokens = opts.maxCompletionTokens ?? 4096;
    this.buildMessages = opts.buildMessages;
    this.getToolDefinitions = opts.getToolDefinitions;
    this.onConsolidated = opts.onConsolidated;
  }

  // ---------------------------------------------------------------------------
  // Token estimation
  // ---------------------------------------------------------------------------

  estimateSessionPromptTokens(session: Session): number {
    const history = session.getHistory(0);
    const [channel, chatId] = session.key.includes(":")
      ? (session.key.split(":", 2) as [string, string])
      : [null, null];
    const probeMessages = this.buildMessages({
      history,
      currentMessage: "[token-probe]",
      channel,
      chatId,
      key: session.key,
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

    // Whether any round actually wrote to memory — gates the post-reindex so we
    // don't refresh the index on a no-op pass.
    let changed = false;
    try {
      for (let round = 0; round < MemoryConsolidator.MAX_CONSOLIDATION_ROUNDS; round++) {
        if (estimated <= target) return;

        const boundary = this.pickConsolidationBoundary(session, Math.max(1, estimated - target));
        if (!boundary) return;

        const chunk = session.messages.slice(session.lastConsolidated, boundary.endIdx);
        if (!chunk.length) return;

        logger.info(
          {
            round,
            key: session.key,
            estimated,
            total: this.contextWindowTokens,
            chunk: chunk.length,
          },
          "Memory consolidation round",
        );

        const ok = await this.stores.for(session.key).consolidate(chunk, this.provider, this.model);
        if (!ok) return;
        changed = true;

        session.lastConsolidated = boundary.endIdx;
        await this.sessions.save(session);

        estimated = this.estimateSessionPromptTokens(session);
        if (estimated <= 0) return;
      }
    } finally {
      // Refresh the search index once, after all rounds, so newly written notes
      // and logs are immediately searchable rather than on the next lazy search.
      if (changed && this.onConsolidated) {
        try {
          await this.onConsolidated(session.key);
        } catch (err) {
          logger.warn({ err, key: session.key }, "post-consolidation reindex failed");
        }
      }
    }
  }
}
