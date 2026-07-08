import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../../utils/logger.js";
import type { EmbeddingProvider } from "../memory-embeddings.js";
import { MemoryIndex, type MemoryIndexOptions } from "../memory-index.js";
import { MemoryStore } from "../memory.js";
import { Tool } from "./base.js";

/**
 * Shared backing for the memory tools. Holds one `MemoryStore` + `MemoryIndex`
 * per session key (isolated on disk), tracks the active session, and serializes
 * reindexing so concurrent tool calls never write the same SQLite file at once.
 *
 * The active key is set per turn by the agent loop (mirroring `CronTool`), so a
 * single registered tool instance serves every session without leaking memory
 * across chats.
 */
export class MemorySearchService {
  private readonly indexes = new Map<string, { store: MemoryStore; index: MemoryIndex }>();
  private readonly reindexing = new Map<string, Promise<void>>();
  /** Fallback active key for serialized callers (gateway loop, CLI). */
  private currentKey = "";
  /**
   * Per-async-context key. Used by concurrent callers (the API server, where
   * distinct sessions run at once) so a tool call always resolves the session
   * that started its turn — never a sibling turn's session.
   */
  private readonly als = new AsyncLocalStorage<string>();

  constructor(
    private readonly workspace: string,
    private readonly embedder: EmbeddingProvider | null,
    private readonly indexOptions: MemoryIndexOptions = {},
  ) {}

  /** Set the active session for serialized callers (loop/CLI). */
  setSessionKey(key: string): void {
    this.currentKey = key;
  }

  /** Run `fn` with `key` bound as the active session for its entire async tree. */
  runWithSession<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.currentKey = key;
    return this.als.run(key, fn);
  }

  private activeKey(): string {
    return this.als.getStore() ?? this.currentKey;
  }

  private resolve(): { store: MemoryStore; index: MemoryIndex } {
    return this.resolveFor(this.activeKey());
  }

  /** Get (or lazily build) the store+index for a specific key without changing
   * the active session — safe to call from outside a turn (e.g. after consolidation). */
  private resolveFor(key: string): { store: MemoryStore; index: MemoryIndex } {
    let entry = this.indexes.get(key);
    if (!entry) {
      const store = new MemoryStore(this.workspace, key || null);
      const index = new MemoryIndex(store.dir, { ...this.indexOptions, embedder: this.embedder });
      entry = { store, index };
      this.indexes.set(key, entry);
    }
    return entry;
  }

  /**
   * Force a reindex of a session's memory (incremental by mtime). Called right
   * after consolidation writes new notes/logs so search reflects them at once,
   * instead of waiting for the next lazy `search`.
   */
  async reindex(key: string): Promise<void> {
    const { index } = this.resolveFor(key);
    await this.ensureIndexed(key, index);
  }

  /** Reindex the active session's memory dir, coalescing concurrent calls. */
  private async ensureIndexed(key: string, index: MemoryIndex): Promise<void> {
    const inflight = this.reindexing.get(key);
    if (inflight) return inflight;
    const p = index.reindex().finally(() => {
      if (this.reindexing.get(key) === p) this.reindexing.delete(key);
    });
    this.reindexing.set(key, p);
    return p;
  }

  async search(query: string, limit: number): Promise<string> {
    const key = this.activeKey();
    const { index } = this.resolve();
    await this.ensureIndexed(key, index);
    const hits = await index.search(query, { limit });
    if (!hits.length) return "No matching memory found.";
    return hits
      .map((h) => {
        const tag = h.linked ? " [linked]" : "";
        return `${h.path}:${h.startLine}-${h.endLine} (score ${h.score})${tag}\n${h.snippet}`;
      })
      .join("\n\n---\n\n");
  }

  /** Formatted outgoing links, backlinks, and neighbors for a note. */
  async linksText(note: string, depth = 1): Promise<string> {
    const key = this.activeKey();
    const { index } = this.resolve();
    await this.ensureIndexed(key, index);
    const info = index.links(note);

    const lines: string[] = [`Note: ${info.path}`];

    lines.push("", "Outgoing links:");
    if (info.outgoing.length === 0) lines.push("  (none)");
    for (const o of info.outgoing) {
      lines.push(
        `  - [[${o.target}]] ${o.resolvedPath ? `→ ${o.resolvedPath}` : "(stub — not yet written)"}`,
      );
    }

    lines.push("", "Backlinks (notes linking here):");
    if (info.backlinks.length === 0) lines.push("  (none)");
    for (const b of info.backlinks) lines.push(`  - ${b}`);

    if (depth >= 2 && info.neighbors.length) {
      const twoHop = new Set<string>();
      for (const n of info.neighbors) {
        for (const nn of index.links(n).neighbors) {
          if (nn !== info.path && !info.neighbors.includes(nn)) twoHop.add(nn);
        }
      }
      if (twoHop.size) {
        lines.push("", "2-hop neighbors:");
        for (const p of twoHop) lines.push(`  - ${p}`);
      }
    }
    return lines.join("\n");
  }

  /**
   * Write durable memory. `target` is `MEMORY.md`, `daily` (today's log), or a
   * note name (stored as `notes/<name>.md` and linkable via `[[name]]`).
   */
  writeMemory(target: string, content: string, append: boolean): string {
    const { store } = this.resolve();
    const t = target.trim();
    const low = t.toLowerCase();

    if (low === "memory.md" || low === "memory") {
      if (append) {
        const prev = store.readLongTerm().trimEnd();
        store.writeLongTerm(prev ? `${prev}\n\n${content}` : content);
      } else {
        store.writeLongTerm(content);
      }
      return `Wrote MEMORY.md (${content.length} chars).`;
    }
    if (low === "daily" || low === "today" || low === "log") {
      store.appendDaily(content);
      return "Appended to today's daily log.";
    }
    const name = t.replace(/\.md$/i, "");
    store.writeNote(name, content, append);
    return `Wrote note notes/${name}.md (${content.length} chars). Link to it elsewhere with [[${name}]].`;
  }

  read(path: string, startLine?: number, endLine?: number): string {
    const { store } = this.resolve();
    const base = resolve(store.dir);
    // Accept either a bare filename or a full/relative path; confine to the dir.
    const candidate = resolve(base, path.startsWith("/") ? path.slice(1) : path);
    if (candidate !== base && !candidate.startsWith(`${base}/`)) {
      throw new Error(`path ${path} is outside the memory directory`);
    }
    if (!existsSync(candidate)) {
      throw new Error(`memory file not found: ${path}`);
    }
    const content = readFileSync(candidate, "utf-8");
    if (startLine == null && endLine == null) return content;
    const lines = content.split("\n");
    const from = Math.max(1, startLine ?? 1);
    const to = Math.min(lines.length, endLine ?? lines.length);
    return lines.slice(from - 1, to).join("\n");
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export class MemorySearchTool extends Tool {
  readonly name = "memory_search";
  readonly description =
    "Search your long-term memory (MEMORY.md and daily logs) for information not " +
    "currently in context. Hybrid keyword + semantic search. Use this to recall " +
    "past facts, decisions, or preferences before answering.";
  readonly parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "What to recall (natural language or keywords)." },
      limit: {
        type: "integer",
        description: "Max snippets to return (default 5).",
        minimum: 1,
        maximum: 20,
      },
    },
    required: ["query"],
  };

  override get readOnly(): boolean {
    return true;
  }

  constructor(private readonly service: MemorySearchService) {
    super();
  }

  async execute(params: Record<string, unknown>): Promise<unknown> {
    const query = String(params["query"] ?? "").trim();
    if (!query) return "Provide a non-empty query.";
    const limit = typeof params["limit"] === "number" ? (params["limit"] as number) : 5;
    try {
      return await this.service.search(query, limit);
    } catch (err) {
      logger.warn({ err }, "memory_search failed");
      return `memory_search error: ${(err as Error).message}`;
    }
  }
}

export class MemoryGetTool extends Tool {
  readonly name = "memory_get";
  readonly description =
    "Read a memory file (e.g. MEMORY.md or a daily log like 2026-07-08.md) by name, " +
    "optionally a line range. Use after memory_search to read fuller context.";
  readonly parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Memory file name, e.g. 'MEMORY.md' or '2026-07-08.md'.",
      },
      start_line: { type: "integer", description: "1-based start line (optional).", minimum: 1 },
      end_line: {
        type: "integer",
        description: "1-based end line, inclusive (optional).",
        minimum: 1,
      },
    },
    required: ["path"],
  };

  override get readOnly(): boolean {
    return true;
  }

  constructor(private readonly service: MemorySearchService) {
    super();
  }

  async execute(params: Record<string, unknown>): Promise<unknown> {
    const path = String(params["path"] ?? "").trim();
    if (!path) return "Provide a memory file path.";
    const start =
      typeof params["start_line"] === "number" ? (params["start_line"] as number) : undefined;
    const end = typeof params["end_line"] === "number" ? (params["end_line"] as number) : undefined;
    try {
      return this.service.read(path, start, end);
    } catch (err) {
      return `memory_get error: ${(err as Error).message}`;
    }
  }
}

export class MemoryLinksTool extends Tool {
  readonly name = "memory_links";
  readonly description =
    "Show how a memory note connects to others: its outgoing [[wikilinks]], its " +
    "backlinks (notes that link to it), and neighbor notes. Use to traverse the " +
    "memory graph and gather related context around an entity or topic.";
  readonly parameters = {
    type: "object",
    properties: {
      note: {
        type: "string",
        description: "Note name or file (e.g. 'Apollo' or 'notes/Apollo.md').",
      },
      depth: {
        type: "integer",
        description: "1 (default) or 2 for 2-hop neighbors.",
        minimum: 1,
        maximum: 2,
      },
    },
    required: ["note"],
  };

  override get readOnly(): boolean {
    return true;
  }

  constructor(private readonly service: MemorySearchService) {
    super();
  }

  async execute(params: Record<string, unknown>): Promise<unknown> {
    const note = String(params["note"] ?? "").trim();
    if (!note) return "Provide a note name.";
    const depth = typeof params["depth"] === "number" ? (params["depth"] as number) : 1;
    try {
      return await this.service.linksText(note, depth);
    } catch (err) {
      logger.warn({ err }, "memory_links failed");
      return `memory_links error: ${(err as Error).message}`;
    }
  }
}

export class MemoryWriteTool extends Tool {
  readonly name = "memory_write";
  readonly description =
    "Persist durable memory so it survives future sessions. Target 'MEMORY.md' for " +
    "curated long-term facts, 'daily' for today's running log, or a note name to " +
    "create/update an atomic note (notes/<name>.md). Connect notes with [[wikilinks]] " +
    "in the content to build a knowledge graph (e.g. [[Alice]] works on [[Project Apollo]]).";
  readonly parameters = {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "'MEMORY.md', 'daily', or a note name (e.g. 'Project Apollo').",
      },
      content: {
        type: "string",
        description: "Markdown content to write. Use [[links]] to connect notes.",
      },
      append: {
        type: "boolean",
        description: "Append instead of overwrite (default false; 'daily' always appends).",
      },
    },
    required: ["target", "content"],
  };

  constructor(private readonly service: MemorySearchService) {
    super();
  }

  async execute(params: Record<string, unknown>): Promise<unknown> {
    const target = String(params["target"] ?? "").trim();
    const content = String(params["content"] ?? "");
    if (!target) return "Provide a target ('MEMORY.md', 'daily', or a note name).";
    if (!content.trim()) return "Provide non-empty content.";
    const append = params["append"] === true;
    try {
      return this.service.writeMemory(target, content, append);
    } catch (err) {
      logger.warn({ err }, "memory_write failed");
      return `memory_write error: ${(err as Error).message}`;
    }
  }
}
