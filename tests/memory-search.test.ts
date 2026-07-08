/**
 * Tests for OpenClaw-style memory: chunking, the hybrid index (keyword-only
 * path — no network), the per-session search service (isolation + concurrency),
 * daily logs, and vector math.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { chunkMarkdown, estimateTokens } from "../src/agent/memory-chunk.js";
import { MemoryIndex, parseWikilinks, normalizeNoteName } from "../src/agent/memory-index.js";
import { MemoryStore } from "../src/agent/memory.js";
import { MemorySearchService } from "../src/agent/tools/memory.js";
import {
  cosineSimilarity,
  packVector,
  unpackVector,
  type EmbeddingProvider,
} from "../src/agent/memory-embeddings.js";

/** Deterministic offline embedder: bag-of-words hashed into fixed dims. */
function embedText(t: string): number[] {
  const dims = 24;
  const v = new Array(dims).fill(0);
  for (const tok of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of tok) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
    v[h % dims] += 1;
  }
  return v;
}
class FakeEmbedder implements EmbeddingProvider {
  readonly id = "fake:test:local";
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(embedText);
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/tarantul-mem-`);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

describe("chunkMarkdown", () => {
  it("returns empty for blank input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n  ")).toEqual([]);
  });

  it("produces line-aligned chunks covering the file", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1} some words here`).join("\n");
    const chunks = chunkMarkdown(text, { maxTokens: 40, overlapTokens: 8 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.startLine).toBe(1);
    // Chunks stay within the file and advance forward.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBeGreaterThan(chunks[i - 1]!.startLine);
    }
    expect(chunks.at(-1)!.endLine).toBe(50);
  });

  it("keeps an oversized single line as its own chunk (forward progress)", () => {
    const big = "x".repeat(4000);
    const text = `short\n${big}\nafter`;
    const chunks = chunkMarkdown(text, { maxTokens: 100, overlapTokens: 10 });
    expect(chunks.some((c) => c.text.includes(big))).toBe(true);
  });

  it("estimateTokens is roughly chars/4", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// MemoryIndex (keyword-only: no embedder)
// ---------------------------------------------------------------------------

describe("MemoryIndex (FTS keyword)", () => {
  it("indexes memory files and finds keyword matches with line ranges", async () => {
    const store = new MemoryStore(dir);
    store.writeLongTerm("The gateway runs on the Mac Studio host.\nAPI key is stored in vault.");
    const index = new MemoryIndex(store.dir);
    await index.reindex();

    const hits = await index.search("gateway", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.path).toBe("MEMORY.md");
    expect(hits[0]!.snippet).toContain("gateway");
    expect(hits[0]!.startLine).toBeGreaterThanOrEqual(1);
    index.close();
  });

  it("returns nothing for an unrelated query", async () => {
    const store = new MemoryStore(dir);
    store.writeLongTerm("cats are great");
    const index = new MemoryIndex(store.dir);
    await index.reindex();
    expect(await index.search("kubernetes helm chart", { limit: 5 })).toEqual([]);
    index.close();
  });

  it("reflects edits and deletions on reindex", async () => {
    const store = new MemoryStore(dir);
    store.writeLongTerm("alpha beta gamma");
    const index = new MemoryIndex(store.dir);
    await index.reindex();
    expect((await index.search("gamma", { limit: 5 })).length).toBeGreaterThan(0);

    // Overwrite so the old term is gone; mtime changes → reindex picks it up.
    await new Promise((r) => setTimeout(r, 5));
    store.writeLongTerm("delta epsilon");
    await index.reindex();
    expect(await index.search("gamma", { limit: 5 })).toEqual([]);
    expect((await index.search("epsilon", { limit: 5 })).length).toBeGreaterThan(0);
    index.close();
  });
});

// ---------------------------------------------------------------------------
// MemoryIndex with embeddings (exercises vector + MMR + decay paths)
// ---------------------------------------------------------------------------

describe("MemoryIndex (hybrid with embedder)", () => {
  it("stores vectors, ranks by cosine, and returns positive vectorScore", async () => {
    const store = new MemoryStore(dir);
    store.writeLongTerm(
      [
        "The database migration runs nightly on the postgres primary.",
        "Coffee preferences: the user likes a flat white in the morning.",
      ].join("\n"),
    );
    const index = new MemoryIndex(store.dir, { embedder: new FakeEmbedder(), chunkMaxTokens: 12, chunkOverlapTokens: 2 });
    await index.reindex();

    const hits = await index.search("postgres database migration", { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    // The database line should outrank the coffee line, with a vector signal.
    expect(hits[0]!.snippet.toLowerCase()).toContain("database");
    expect(hits[0]!.vectorScore).toBeGreaterThan(0);
    index.close();
  });

  it("re-embeds when the embedder fingerprint changes", async () => {
    const store = new MemoryStore(dir);
    store.writeLongTerm("vector fingerprint test content");
    const keywordOnly = new MemoryIndex(store.dir);
    await keywordOnly.reindex();
    keywordOnly.close();

    // New index with an embedder → fingerprint differs → full rebuild with vectors.
    const withVecs = new MemoryIndex(store.dir, { embedder: new FakeEmbedder() });
    await withVecs.reindex();
    const hits = await withVecs.search("fingerprint", { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.vectorScore).toBeGreaterThan(0);
    withVecs.close();
  });
});

// ---------------------------------------------------------------------------
// MemorySearchService — per-session isolation + concurrency
// ---------------------------------------------------------------------------

describe("MemorySearchService", () => {
  it("isolates memory between session keys", async () => {
    // Seed two sessions' memory dirs.
    new MemoryStore(dir, "telegram:1").writeLongTerm("project apollo launch codes");
    new MemoryStore(dir, "slack:2").writeLongTerm("project zephyr weather data");

    const svc = new MemorySearchService(dir, null);

    svc.setSessionKey("telegram:1");
    expect(await svc.search("apollo", 5)).toContain("apollo");
    expect(await svc.search("zephyr", 5)).toBe("No matching memory found.");

    svc.setSessionKey("slack:2");
    expect(await svc.search("zephyr", 5)).toContain("zephyr");
    expect(await svc.search("apollo", 5)).toBe("No matching memory found.");
  });

  it("binds the right session under concurrent runWithSession", async () => {
    new MemoryStore(dir, "a:1").writeLongTerm("unique_alpha_token here");
    new MemoryStore(dir, "b:2").writeLongTerm("unique_bravo_token here");

    const svc = new MemorySearchService(dir, null);
    const [a, b] = await Promise.all([
      svc.runWithSession("a:1", () => svc.search("unique_alpha_token", 5)),
      svc.runWithSession("b:2", () => svc.search("unique_bravo_token", 5)),
    ]);
    expect(a).toContain("alpha");
    expect(b).toContain("bravo");
    // Cross-checks: neither session should surface the other's token.
    expect(a).not.toContain("bravo");
    expect(b).not.toContain("alpha");
  });

  it("memory_get reads within the dir and rejects escapes", async () => {
    const store = new MemoryStore(dir, "cli:direct");
    store.writeLongTerm("line one\nline two\nline three");
    const svc = new MemorySearchService(dir, null);
    svc.setSessionKey("cli:direct");

    expect(svc.read("MEMORY.md")).toContain("line two");
    expect(svc.read("MEMORY.md", 2, 2)).toBe("line two");
    expect(() => svc.read("../../etc/passwd")).toThrow(/outside the memory directory/);
  });
});

// ---------------------------------------------------------------------------
// Daily logs + memory context
// ---------------------------------------------------------------------------

describe("MemoryStore daily logs", () => {
  it("appendDaily writes a dated file and getMemoryContext includes it", () => {
    const store = new MemoryStore(dir);
    store.writeLongTerm("durable fact about the user");
    store.appendDaily("today we discussed the deploy plan");

    const onDisk = readFileSync(store.dailyLogPath(), "utf-8");
    expect(onDisk).toContain("deploy plan");

    const ctx = store.getMemoryContext();
    expect(ctx).toContain("## Long-term Memory");
    expect(ctx).toContain("durable fact about the user");
    expect(ctx).toContain("## Recent Daily Log");
    expect(ctx).toContain("deploy plan");
  });
});

// ---------------------------------------------------------------------------
// Wikilink graph
// ---------------------------------------------------------------------------

describe("parseWikilinks", () => {
  it("extracts targets, stripping aliases and headings", () => {
    const text = "See [[Apollo]] and [[Bob|the lead]] plus [[Notes#today]] but not [[]].";
    expect(parseWikilinks(text)).toEqual(["Apollo", "Bob", "Notes"]);
  });
  it("normalizeNoteName lowercases and trims", () => {
    expect(normalizeNoteName("  Project Apollo ")).toBe("project apollo");
  });
});

describe("MemoryIndex graph", () => {
  it("resolves links to notes, records backlinks, and marks stubs", async () => {
    const store = new MemoryStore(dir);
    store.writeLongTerm("Team overview. The lead is Alice. See [[Apollo]] and [[Nonexistent]].");
    store.writeNote("Apollo", "Apollo is the flagship rocket program.");
    const index = new MemoryIndex(store.dir);
    await index.reindex();

    expect(index.resolveNote("Apollo")).toBe("notes/Apollo.md");

    const mem = index.links("MEMORY.md");
    const apollo = mem.outgoing.find((o) => o.target === "Apollo");
    const stub = mem.outgoing.find((o) => o.target === "Nonexistent");
    expect(apollo?.resolvedPath).toBe("notes/Apollo.md");
    expect(stub?.resolvedPath).toBeNull();

    const note = index.links("Apollo");
    expect(note.backlinks).toContain("MEMORY.md");
    index.close();
  });

  it("surfaces a linked note that did not match the query (graph expansion)", async () => {
    const store = new MemoryStore(dir);
    store.writeLongTerm("Alice is the lead engineer. See [[Apollo]].");
    store.writeNote("Apollo", "The rocket program uses cryogenic fuel.");
    const index = new MemoryIndex(store.dir); // no embedder → FTS + graph
    await index.reindex();

    const hits = await index.search("Alice engineer", { limit: 5 });
    const linked = hits.find((h) => h.path === "notes/Apollo.md");
    expect(linked).toBeDefined();
    expect(linked!.linked).toBe(true);
    // The direct match should still be present and rank first.
    expect(hits[0]!.path).toBe("MEMORY.md");
    index.close();
  });
});

describe("MemorySearchService graph + write", () => {
  it("memory_write creates a linked note that becomes searchable", async () => {
    const svc = new MemorySearchService(dir, null);
    svc.setSessionKey("cli:direct");

    const msg = svc.writeMemory("Project Apollo", "Uses [[Postgres]] for storage.", false);
    expect(msg).toContain("notes/Project Apollo.md");

    expect(await svc.search("postgres storage", 5)).toContain("Postgres");

    const links = await svc.linksText("Project Apollo");
    expect(links).toContain("[[Postgres]]");
    expect(links).toContain("stub"); // Postgres note not written yet
  });

  it("memory_write appends to MEMORY.md", () => {
    const svc = new MemorySearchService(dir, null);
    svc.setSessionKey("cli:direct");
    svc.writeMemory("MEMORY.md", "first fact", false);
    svc.writeMemory("MEMORY.md", "second fact", true);
    expect(new MemoryStore(dir, "cli:direct").readLongTerm()).toContain("first fact");
    expect(new MemoryStore(dir, "cli:direct").readLongTerm()).toContain("second fact");
  });
});

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

describe("embedding vector math", () => {
  it("cosineSimilarity: identical=1, orthogonal=0, mismatch=0", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  it("pack/unpack round-trips a float vector", () => {
    const v = [0.5, -1.25, 3.0, 0];
    const back = unpackVector(packVector(v));
    expect(back.length).toBe(4);
    for (let i = 0; i < v.length; i++) expect(back[i]!).toBeCloseTo(v[i]!, 5);
  });
});
