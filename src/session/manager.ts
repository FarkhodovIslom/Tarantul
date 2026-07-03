
import { join } from "node:path";
import { existsSync, mkdirSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import { logger } from "../utils/logger.js";
import { safeFilename, findLegalMessageStart } from "../utils/helpers.js";

/** Bytes read from the start of a session file to extract its metadata line. */
const METADATA_HEAD_BYTES = 8192;

/**
 * Read a bounded prefix of a file synchronously, without loading the whole
 * thing. Used by `listSessions()` — session files can grow to megabytes of
 * conversation history, but the metadata line we need is always line 1.
 */
function readHead(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf-8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionData {
  /** channel:chat_id composite key */
  key: string;
  messages: Record<string, unknown>[];
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  /** Number of messages already consolidated to memory files (skip on replay). */
  lastConsolidated: number;
}

export class Session implements SessionData {
  key: string;
  messages: Record<string, unknown>[];
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  lastConsolidated: number;

  constructor(data: Partial<SessionData> & { key: string }) {
    this.key = data.key;
    this.messages = data.messages ?? [];
    this.createdAt = data.createdAt ?? new Date();
    this.updatedAt = data.updatedAt ?? new Date();
    this.metadata = data.metadata ?? {};
    this.lastConsolidated = data.lastConsolidated ?? 0;
  }

  /**
   * Add a message to the session.
   * Stamps a timestamp if absent.
   */
  addMessage(role: string, content: string, extra?: Record<string, unknown>): void {
    this.messages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
      ...extra,
    });
    this.updatedAt = new Date();
  }

  /**
   * Return unconsolidated messages aligned to a legal tool-call boundary.
   * When maxMessages=0 all unconsolidated messages are returned.
   */
  getHistory(maxMessages = 500): Record<string, unknown>[] {
    const unconsolidated = this.messages.slice(this.lastConsolidated);
    let sliced = maxMessages > 0 ? unconsolidated.slice(-maxMessages) : unconsolidated;

    // Start at the first user message to avoid mid-turn slices
    const firstUser = sliced.findIndex((m) => m["role"] === "user");
    if (firstUser > 0) sliced = sliced.slice(firstUser);

    // Drop orphan tool results at the front
    const start = findLegalMessageStart(sliced);
    if (start > 0) sliced = sliced.slice(start);

    // Project only the fields the LLM provider expects
    return sliced.map((m) => {
      const entry: Record<string, unknown> = {
        role: m["role"],
        content: m["content"] ?? "",
      };
      for (const key of ["tool_calls", "tool_call_id", "name"] as const) {
        if (key in m) entry[key] = m[key];
      }
      return entry;
    });
  }

  /** Erase all messages and reset consolidation pointer. */
  clear(): void {
    this.messages = [];
    this.lastConsolidated = 0;
    this.updatedAt = new Date();
  }

  /**
   * Retain only the most recent legal suffix of messages.
   * Mirrors Python `retain_recent_legal_suffix`.
   */
  retainRecentLegalSuffix(maxMessages: number): void {
    if (maxMessages <= 0) {
      this.clear();
      return;
    }
    if (this.messages.length <= maxMessages) return;

    let startIdx = Math.max(0, this.messages.length - maxMessages);

    // Walk back to the nearest user turn to avoid a mid-turn cut
    while (startIdx > 0 && this.messages[startIdx]?.["role"] !== "user") {
      startIdx--;
    }

    let retained = this.messages.slice(startIdx);

    // Drop orphan tool results at the new front
    const legalStart = findLegalMessageStart(retained);
    if (legalStart > 0) retained = retained.slice(legalStart);

    const dropped = this.messages.length - retained.length;
    this.messages = retained;
    this.lastConsolidated = Math.max(0, this.lastConsolidated - dropped);
    this.updatedAt = new Date();
  }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private readonly sessionsDir: string;
  private readonly legacyDir: string | null;
  private readonly cache = new Map<string, Session>();

  constructor(workspace: string, legacyDir?: string | null) {
    this.sessionsDir = join(workspace, "sessions");
    this.legacyDir = legacyDir ?? null;

    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Get an existing session from cache/disk, or create a fresh one. */
  getOrCreate(key: string): Session {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const session = this._load(key) ?? new Session({ key });
    this.cache.set(key, session);
    return session;
  }

  /**
   * Persist a session to disk (JSONL), atomically.
   *
   * Writes to a temp file in the same directory, then renames it over the
   * target path. `rename` is atomic on the same filesystem, so a crash or
   * concurrent read never observes a partially-written session file. The
   * in-memory cache is updated synchronously regardless of disk outcome;
   * callers that need durability should await the returned promise.
   */
  async save(session: Session): Promise<void> {
    const path = this._sessionPath(session.key);
    session.updatedAt = new Date();

    const lines: string[] = [
      JSON.stringify({
        _type: "metadata",
        key: session.key,
        created_at: session.createdAt.toISOString(),
        updated_at: session.updatedAt.toISOString(),
        metadata: session.metadata,
        last_consolidated: session.lastConsolidated,
      }),
    ];

    for (const msg of session.messages) {
      lines.push(JSON.stringify(msg));
    }

    this.cache.set(session.key, session);

    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      await Bun.write(tmpPath, lines.join("\n") + "\n");
      renameSync(tmpPath, path);
    } catch (err) {
      logger.error({ err, key: session.key }, "Failed to persist session");
      try {
        require("node:fs").unlinkSync(tmpPath);
      } catch {
        // tmp file was never created — nothing to clean up
      }
    }
  }

  /** Evict a session from the in-memory cache (forces disk reload next access). */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /** List all persisted sessions (reads only the first line of each file). */
  listSessions(): Array<{
    key: string;
    createdAt: string | undefined;
    updatedAt: string | undefined;
    path: string;
  }> {
    const results: ReturnType<SessionManager["listSessions"]> = [];

    let entries: string[] = [];
    try {
      const dir = Bun.file(this.sessionsDir);
      // Read directory listing via node:fs (Bun fs compatible)
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      entries = readdirSync(this.sessionsDir)
        .filter((f: string) => f.endsWith(".jsonl"))
        .map((f: string) => join(this.sessionsDir, f));
    } catch {
      return results;
    }

    for (const filePath of entries) {
      try {
        // Read a bounded prefix, not the whole file — session files can hold
        // megabytes of conversation history, but the metadata we need is
        // always on line 1.
        const head = readHead(filePath, METADATA_HEAD_BYTES);
        const firstLine = head.split("\n")[0]?.trim();
        if (!firstLine) continue;
        const data = JSON.parse(firstLine) as Record<string, unknown>;
        if (data["_type"] !== "metadata") continue;
        const key = (data["key"] as string | undefined) ?? filePath.replace(/\.jsonl$/, "");
        results.push({
          key,
          createdAt: data["created_at"] as string | undefined,
          updatedAt: data["updated_at"] as string | undefined,
          path: filePath,
        });
      } catch {
        continue;
      }
    }

    return results.sort((a, b) => {
      const ta = a.updatedAt ?? "";
      const tb = b.updatedAt ?? "";
      return tb.localeCompare(ta);
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _sessionPath(key: string): string {
    const safeName = safeFilename(key.replace(/:/g, "_"));
    return join(this.sessionsDir, `${safeName}.jsonl`);
  }

  private _legacyPath(key: string): string | null {
    if (!this.legacyDir) return null;
    const safeName = safeFilename(key.replace(/:/g, "_"));
    return join(this.legacyDir, `${safeName}.jsonl`);
  }

  private _load(key: string): Session | null {
    let path = this._sessionPath(key);

    // Try migrating from legacy location
    if (!existsSync(path)) {
      const legacy = this._legacyPath(key);
      if (legacy && existsSync(legacy)) {
        try {
          renameSync(legacy, path);
          logger.info({ key }, "Migrated session from legacy path");
        } catch (err) {
          logger.warn({ err, key }, "Failed to migrate session from legacy path");
          path = legacy; // fall back to reading from legacy path
        }
      }
    }

    if (!existsSync(path)) return null;

    try {
      const raw = require("node:fs").readFileSync(path, "utf-8") as string;
      const lines = raw.split("\n").filter((l: string) => l.trim());

      const messages: Record<string, unknown>[] = [];
      let metadata: Record<string, unknown> = {};
      let createdAt: Date | undefined;
      let lastConsolidated = 0;

      for (const line of lines) {
        const data = JSON.parse(line) as Record<string, unknown>;
        if (data["_type"] === "metadata") {
          metadata = (data["metadata"] as Record<string, unknown> | undefined) ?? {};
          createdAt = data["created_at"]
            ? new Date(data["created_at"] as string)
            : undefined;
          lastConsolidated = (data["last_consolidated"] as number | undefined) ?? 0;
        } else {
          messages.push(data);
        }
      }

      return new Session({
        key,
        messages,
        createdAt: createdAt ?? new Date(),
        metadata,
        lastConsolidated,
      });
    } catch (err) {
      logger.warn({ err, key }, "Failed to load session from disk");
      return null;
    }
  }
}
