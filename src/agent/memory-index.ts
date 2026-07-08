/**
 * Hybrid memory index: FTS5 (BM25 keyword) + optional embedding vectors
 * (JS cosine over Float32 blobs, since Bun's sqlite can't load sqlite-vec).
 *
 * One SQLite database per session memory directory (`<memoryDir>/index.sqlite`),
 * so the index inherits the same per-session isolation as the Markdown files.
 * Indexing is incremental by file mtime; a change to the embedding provider
 * fingerprint forces a full rebuild.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { chunkMarkdown } from "./memory-chunk.js";
import {
  type EmbeddingProvider,
  cosineSimilarity,
  packVector,
  unpackVector,
} from "./memory-embeddings.js";

const DATED_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;

export interface MemoryIndexOptions {
  embedder?: EmbeddingProvider | null;
  vectorWeight?: number;
  textWeight?: number;
  chunkMaxTokens?: number;
  chunkOverlapTokens?: number;
  /** Exponential decay half-life for dated files, in days. 0 disables decay. */
  decayHalfLifeDays?: number;
  /** MMR diversity trade-off in [0,1] (1 = pure relevance). Needs embeddings. */
  mmrLambda?: number;
  /** Expand results by 1 hop along wikilinks (graph-augmented retrieval). */
  graphExpansion?: boolean;
  /** Relative score boost applied to a candidate linked to a top hit. */
  graphBoost?: number;
  /** Max linked-but-unmatched notes pulled in per query. */
  graphNeighborLimit?: number;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  /** Which signals contributed: for observability/debugging. */
  vectorScore: number;
  textScore: number;
  /** True when surfaced via a wikilink from a directly-matched hit. */
  linked?: boolean;
}

/** Outgoing/incoming links + resolved neighbors for a note. */
export interface LinkInfo {
  path: string;
  outgoing: Array<{ target: string; resolvedPath: string | null }>;
  backlinks: string[];
  /** Distinct resolved neighbor file paths (outgoing resolved ∪ backlinks). */
  neighbors: string[];
}

interface Candidate {
  id: number;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  evergreen: boolean;
  fileMtime: number;
  embedding: number[] | null;
  vectorScore: number;
  textScore: number;
  linked?: boolean;
}

export class MemoryIndex {
  private readonly db: Database;
  private readonly embedder: EmbeddingProvider | null;
  private readonly vectorWeight: number;
  private readonly textWeight: number;
  private readonly chunkMaxTokens: number;
  private readonly chunkOverlapTokens: number;
  private readonly decayHalfLifeDays: number;
  private readonly mmrLambda: number;
  private readonly graphExpansion: boolean;
  private readonly graphBoost: number;
  private readonly graphNeighborLimit: number;

  constructor(
    private readonly memoryDir: string,
    opts: MemoryIndexOptions = {},
  ) {
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
    this.embedder = opts.embedder ?? null;
    this.vectorWeight = opts.vectorWeight ?? 0.6;
    this.textWeight = opts.textWeight ?? 0.4;
    this.chunkMaxTokens = opts.chunkMaxTokens ?? 400;
    this.chunkOverlapTokens = opts.chunkOverlapTokens ?? 80;
    this.decayHalfLifeDays = opts.decayHalfLifeDays ?? 30;
    this.mmrLambda = opts.mmrLambda ?? 0.7;
    this.graphExpansion = opts.graphExpansion ?? true;
    this.graphBoost = opts.graphBoost ?? 0.25;
    this.graphNeighborLimit = opts.graphNeighborLimit ?? 3;

    this.db = new Database(join(memoryDir, "index.sqlite"));
    this.db.run("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      mtime REAL NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      evergreen INTEGER NOT NULL DEFAULT 0,
      file_mtime REAL NOT NULL,
      embedding BLOB
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path)");
    this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text)");
    this.db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    // Obsidian-style wikilinks: one row per [[target]] occurrence.
    this.db.run(`CREATE TABLE IF NOT EXISTS links (
      src_path TEXT NOT NULL,
      target TEXT NOT NULL,
      raw_target TEXT NOT NULL,
      resolved_path TEXT
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_links_src ON links(src_path)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_links_target ON links(target)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_links_resolved ON links(resolved_path)");
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  private getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.run(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

  /** Relative paths of all markdown files: top-level plus the `notes/` subdir. */
  private listMarkdownFiles(): string[] {
    const out: string[] = [];
    const scan = (sub: string): void => {
      const dir = sub ? join(this.memoryDir, sub) : this.memoryDir;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const f of entries) {
        if (f.endsWith(".md")) out.push(sub ? `${sub}/${f}` : f);
      }
    };
    scan("");
    scan("notes");
    return out;
  }

  private deleteFileChunks(path: string): void {
    const ids = this.db.query("SELECT id FROM chunks WHERE path = ?").all(path) as { id: number }[];
    for (const { id } of ids) {
      this.db.run("DELETE FROM chunks_fts WHERE rowid = ?", [id]);
    }
    this.db.run("DELETE FROM chunks WHERE path = ?", [path]);
    this.db.run("DELETE FROM links WHERE src_path = ?", [path]);
  }

  /**
   * Bring the index up to date with the Markdown files on disk. Incremental by
   * mtime; re-embeds only changed files. A change in embedding fingerprint (or
   * enabling/disabling embeddings) triggers a full rebuild.
   */
  async reindex(): Promise<void> {
    const fingerprint = this.embedder?.id ?? "none";
    if (this.getMeta("embedding_id") !== fingerprint) {
      this.db.run("DELETE FROM chunks");
      this.db.run("DELETE FROM chunks_fts");
      this.db.run("DELETE FROM files");
      this.db.run("DELETE FROM links");
      this.setMeta("embedding_id", fingerprint);
    }

    const onDisk = new Set<string>();
    for (const name of this.listMarkdownFiles()) {
      onDisk.add(name);
      const full = join(this.memoryDir, name);
      let mtime: number;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      const known = this.db.query("SELECT mtime FROM files WHERE path = ?").get(name) as
        | { mtime: number }
        | undefined;
      if (known && known.mtime === mtime) continue; // unchanged

      let content = "";
      try {
        content = readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      await this.indexFile(name, content, mtime);
    }

    // Drop files that vanished from disk.
    const knownFiles = this.db.query("SELECT path FROM files").all() as { path: string }[];
    for (const { path } of knownFiles) {
      if (!onDisk.has(path)) {
        this.deleteFileChunks(path);
        this.db.run("DELETE FROM files WHERE path = ?", [path]);
      }
    }

    this.resolveLinks();
  }

  /**
   * Resolve every wikilink's target to a concrete file path (or leave NULL as a
   * "stub" — a note the agent referenced but hasn't written yet). Runs after all
   * files are indexed so link targets can point at notes indexed in any order.
   */
  private resolveLinks(): void {
    const files = this.db.query("SELECT path FROM files").all() as { path: string }[];
    const byName = new Map<string, string>();
    for (const { path } of files) {
      const name = normalizeNoteName(baseName(path));
      // Prefer a note in the notes/ dir when names collide.
      if (!byName.has(name) || path.startsWith("notes/")) byName.set(name, path);
    }
    const rows = this.db.query("SELECT rowid, target FROM links").all() as Array<{
      rowid: number;
      target: string;
    }>;
    const update = this.db.prepare("UPDATE links SET resolved_path = ? WHERE rowid = ?");
    const tx = this.db.transaction(() => {
      for (const { rowid, target } of rows) {
        update.run(byName.get(target) ?? null, rowid);
      }
    });
    tx();
  }

  private async indexFile(path: string, content: string, mtime: number): Promise<void> {
    this.deleteFileChunks(path);

    const chunks = chunkMarkdown(content, {
      maxTokens: this.chunkMaxTokens,
      overlapTokens: this.chunkOverlapTokens,
    });
    const evergreen = DATED_FILE_RE.test(path) ? 0 : 1;

    // Embed all chunk texts up front (one batch). Failure → keyword-only for this file.
    let vectors: (number[] | null)[] = chunks.map(() => null);
    if (this.embedder && chunks.length) {
      try {
        const embedded = await this.embedder.embed(chunks.map((c) => c.text));
        if (embedded.length === chunks.length) vectors = embedded;
      } catch (err) {
        logger.warn({ err, path }, "memory embed failed; indexing file keyword-only");
      }
    }

    const insert = this.db.prepare(
      `INSERT INTO chunks(path, start_line, end_line, text, evergreen, file_mtime, embedding)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES(?, ?)");
    const insertLink = this.db.prepare(
      "INSERT INTO links(src_path, target, raw_target, resolved_path) VALUES(?, ?, ?, NULL)",
    );
    const wikilinks = parseWikilinks(content);

    const tx = this.db.transaction(() => {
      chunks.forEach((c, i) => {
        const vec = vectors[i];
        const blob = vec ? packVector(vec) : null;
        const res = insert.run(path, c.startLine, c.endLine, c.text, evergreen, mtime, blob);
        insertFts.run(Number(res.lastInsertRowid), c.text);
      });
      for (const link of wikilinks) {
        insertLink.run(path, normalizeNoteName(link), link);
      }
      this.db.run(
        "INSERT INTO files(path, mtime) VALUES(?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime",
        [path, mtime],
      );
    });
    tx();
  }

  // -------------------------------------------------------------------------
  // Graph queries
  // -------------------------------------------------------------------------

  /** Resolve a note name or path to an indexed file path, or null. */
  resolveNote(nameOrPath: string): string | null {
    const direct = this.db.query("SELECT path FROM files WHERE path = ?").get(nameOrPath) as
      | { path: string }
      | undefined;
    if (direct) return direct.path;
    const target = normalizeNoteName(baseName(nameOrPath));
    const files = this.db.query("SELECT path FROM files").all() as { path: string }[];
    let match: string | null = null;
    for (const { path } of files) {
      if (normalizeNoteName(baseName(path)) === target) {
        if (!match || path.startsWith("notes/")) match = path;
      }
    }
    return match;
  }

  /** Outgoing links, backlinks, and resolved neighbors for a note/path. */
  links(nameOrPath: string): LinkInfo {
    const path = this.resolveNote(nameOrPath) ?? nameOrPath;
    const outgoing = (
      this.db
        .query("SELECT DISTINCT raw_target, resolved_path FROM links WHERE src_path = ?")
        .all(path) as Array<{ raw_target: string; resolved_path: string | null }>
    ).map((r) => ({ target: r.raw_target, resolvedPath: r.resolved_path }));

    const backlinks = (
      this.db
        .query("SELECT DISTINCT src_path FROM links WHERE resolved_path = ?")
        .all(path) as Array<{ src_path: string }>
    ).map((r) => r.src_path);

    const neighbors = [
      ...new Set([
        ...outgoing.map((o) => o.resolvedPath).filter((p): p is string => !!p),
        ...backlinks,
      ]),
    ].filter((p) => p !== path);

    return { path, outgoing, backlinks, neighbors };
  }

  private firstChunk(path: string): { startLine: number; endLine: number; text: string } | null {
    const row = this.db
      .query("SELECT start_line, end_line, text FROM chunks WHERE path = ? ORDER BY id LIMIT 1")
      .get(path) as { start_line: number; end_line: number; text: string } | undefined;
    return row ? { startLine: row.start_line, endLine: row.end_line, text: row.text } : null;
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async search(
    query: string,
    opts: { limit?: number; snippetChars?: number } = {},
  ): Promise<SearchHit[]> {
    const limit = Math.max(1, opts.limit ?? 5);
    const snippetChars = opts.snippetChars ?? 700;
    const pool = Math.max(limit * 4, 20);

    const byId = new Map<number, Candidate>();

    // --- Keyword (BM25) ------------------------------------------------------
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery) {
      try {
        const rows = this.db
          .query(
            `SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.evergreen, c.file_mtime,
                    bm25(chunks_fts) AS bm
             FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
             WHERE chunks_fts MATCH ? ORDER BY bm LIMIT ?`,
          )
          .all(ftsQuery, pool) as Array<Record<string, unknown>>;
        // bm25 is lower-is-better (usually negative). Convert to positive relevance,
        // then min-max normalize across this candidate set below.
        const raw = rows.map((r) => -(r["bm"] as number));
        const { min, max } = minMax(raw);
        rows.forEach((r, i) => {
          const id = r["id"] as number;
          byId.set(id, {
            id,
            path: r["path"] as string,
            startLine: r["start_line"] as number,
            endLine: r["end_line"] as number,
            text: r["text"] as string,
            evergreen: (r["evergreen"] as number) === 1,
            fileMtime: r["file_mtime"] as number,
            embedding: null,
            vectorScore: 0,
            textScore: normalize(raw[i]!, min, max),
          });
        });
      } catch (err) {
        logger.warn({ err }, "memory FTS query failed");
      }
    }

    // --- Vector (cosine) -----------------------------------------------------
    if (this.embedder) {
      try {
        const [qvec] = await this.embedder.embed([query]);
        if (qvec?.length) {
          const rows = this.db
            .query(
              `SELECT id, path, start_line, end_line, text, evergreen, file_mtime, embedding
               FROM chunks WHERE embedding IS NOT NULL`,
            )
            .all() as Array<Record<string, unknown>>;
          const scored = rows.map((r) => {
            const emb = unpackVector(r["embedding"] as Uint8Array);
            return { r, emb, sim: Math.max(0, cosineSimilarity(qvec, emb)) };
          });
          scored.sort((a, b) => b.sim - a.sim);
          for (const { r, emb, sim } of scored.slice(0, pool)) {
            const id = r["id"] as number;
            const existing = byId.get(id);
            if (existing) {
              existing.vectorScore = sim;
              existing.embedding = emb;
            } else {
              byId.set(id, {
                id,
                path: r["path"] as string,
                startLine: r["start_line"] as number,
                endLine: r["end_line"] as number,
                text: r["text"] as string,
                evergreen: (r["evergreen"] as number) === 1,
                fileMtime: r["file_mtime"] as number,
                embedding: emb,
                vectorScore: sim,
                textScore: 0,
              });
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, "memory vector search failed; keyword-only results");
      }
    }

    if (byId.size === 0) return [];

    // --- Combine + temporal decay -------------------------------------------
    const now = Date.now();
    const decayLambda = this.decayHalfLifeDays > 0 ? Math.LN2 / this.decayHalfLifeDays : 0;
    const combined = [...byId.values()].map((c) => {
      let score = this.vectorWeight * c.vectorScore + this.textWeight * c.textScore;
      if (decayLambda > 0 && !c.evergreen) {
        const ageDays = Math.max(0, (now - c.fileMtime) / 86_400_000);
        score *= Math.exp(-decayLambda * ageDays);
      }
      return { c, score };
    });
    combined.sort((a, b) => b.score - a.score);

    // --- Graph expansion: 1 hop along wikilinks -----------------------------
    if (this.graphExpansion) {
      this.expandAlongLinks(combined, limit);
      combined.sort((a, b) => b.score - a.score);
    }

    // --- MMR re-ranking (only when we have embeddings to measure diversity) --
    const ranked =
      this.embedder && combined.some((x) => x.c.embedding)
        ? mmrRerank(combined, this.mmrLambda, limit)
        : combined.slice(0, limit);

    return ranked.map(({ c, score }) => ({
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
      snippet: c.text.length > snippetChars ? `${c.text.slice(0, snippetChars)}…` : c.text,
      score: round(score),
      vectorScore: round(c.vectorScore),
      textScore: round(c.textScore),
      ...(c.linked ? { linked: true } : {}),
    }));
  }

  /**
   * Graph-augmented retrieval. Takes the top `limit` matches as seeds, then:
   *  - boosts any candidate that is a wikilink neighbor of a seed, and
   *  - pulls in up to `graphNeighborLimit` linked notes that matched neither
   *    keyword nor vector search (so explicit relationships surface facts the
   *    query alone would miss). Mutates `combined` in place.
   */
  private expandAlongLinks(combined: Array<{ c: Candidate; score: number }>, limit: number): void {
    const seeds = combined.slice(0, limit);
    const neighborPaths = new Set<string>();
    for (const { c } of seeds) {
      for (const n of this.links(c.path).neighbors) neighborPaths.add(n);
    }
    if (neighborPaths.size === 0) return;

    const present = new Set(combined.map((x) => x.c.path));
    // Boost already-present candidates that are neighbors of a seed.
    for (const item of combined) {
      if (neighborPaths.has(item.c.path)) {
        item.score *= 1 + this.graphBoost;
        item.c.linked = true;
      }
    }
    // Surface linked notes that didn't match directly.
    let added = 0;
    for (const path of neighborPaths) {
      if (added >= this.graphNeighborLimit) break;
      if (present.has(path)) continue;
      const chunk = this.firstChunk(path);
      if (!chunk) continue;
      combined.push({
        c: {
          id: -1,
          path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          evergreen: !DATED_FILE_RE.test(baseName(path)),
          fileMtime: Date.now(),
          embedding: null,
          vectorScore: 0,
          textScore: 0,
          linked: true,
        },
        score: this.graphBoost,
      });
      added++;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract wikilink display targets from markdown. Handles `[[Target]]`,
 * `[[Target|alias]]` (keeps Target), and `[[Target#heading]]` (keeps Target).
 * Ignores empty links. Returns raw (un-normalized) target strings.
 */
export function parseWikilinks(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\[\[([^\]]+?)\]\]/g)) {
    let target = match[1] ?? "";
    const pipe = target.indexOf("|");
    if (pipe >= 0) target = target.slice(0, pipe);
    const hash = target.indexOf("#");
    if (hash >= 0) target = target.slice(0, hash);
    target = target.trim();
    if (target) out.push(target);
  }
  return out;
}

/** Normalize a note name/target for case-insensitive matching. */
export function normalizeNoteName(name: string): string {
  return name.trim().toLowerCase();
}

/** Basename of a rel path without the `.md` extension. */
function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.replace(/\.md$/i, "");
}

/** Build a safe FTS5 OR-of-terms query from arbitrary user text. */
function buildFtsQuery(query: string): string | null {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!terms || terms.length === 0) return null;
  const unique = [...new Set(terms)].slice(0, 32);
  return unique.map((t) => `"${t}"`).join(" OR ");
}

function minMax(xs: number[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const x of xs) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return { min, max };
}

function normalize(x: number, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return x > 0 ? 1 : 0;
  return (x - min) / (max - min);
}

/**
 * Maximal Marginal Relevance: greedily pick items that are relevant but
 * dissimilar to those already picked, using embedding cosine as the similarity.
 */
function mmrRerank(
  items: Array<{ c: Candidate; score: number }>,
  lambda: number,
  limit: number,
): Array<{ c: Candidate; score: number }> {
  const selected: Array<{ c: Candidate; score: number }> = [];
  const pool = [...items];
  while (selected.length < limit && pool.length) {
    let bestIdx = 0;
    let bestVal = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i]!;
      let maxSim = 0;
      if (cand.c.embedding) {
        for (const s of selected) {
          if (s.c.embedding) {
            maxSim = Math.max(maxSim, cosineSimilarity(cand.c.embedding, s.c.embedding));
          }
        }
      }
      const mmr = lambda * cand.score - (1 - lambda) * maxSim;
      if (mmr > bestVal) {
        bestVal = mmr;
        bestIdx = i;
      }
    }
    selected.push(pool.splice(bestIdx, 1)[0]!);
  }
  return selected;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
