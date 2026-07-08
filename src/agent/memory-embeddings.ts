/**
 * Embedding providers for semantic memory search.
 *
 * Thin `fetch`-based clients — no SDK dependency. The active provider is chosen
 * from config (reusing the LLM provider API keys). When no key is available the
 * factory returns `null` and the memory index runs keyword-only (FTS5/BM25).
 */

import { logger } from "../utils/logger.js";

export interface EmbeddingConfig {
  /** "openai" | "gemini" | "openai-compatible" | "voyage" | "none" | "auto" */
  provider: string;
  model: string;
  apiKey: string;
  apiBase?: string | null;
}

export interface EmbeddingProvider {
  /** Stable fingerprint (provider:model:endpoint). A change forces reindex. */
  readonly id: string;
  /** Embed a batch of texts. Order-preserving; throws on transport/API error. */
  embed(texts: string[]): Promise<number[][]>;
}

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const VOYAGE_DEFAULT_BASE = "https://api.voyageai.com/v1";

function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, Voyage, vLLM, any /embeddings endpoint)
// ---------------------------------------------------------------------------

class OpenAICompatEmbeddings implements EmbeddingProvider {
  readonly id: string;
  private readonly url: string;

  constructor(
    label: string,
    private readonly model: string,
    private readonly apiKey: string,
    apiBase: string,
  ) {
    const base = trimBase(apiBase);
    this.url = `${base}/embeddings`;
    this.id = `${label}:${model}:${base}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
    const data = json.data ?? [];
    // Sort by index defensively — most APIs return in order, but not guaranteed.
    const ordered = data.every((d) => typeof d.index === "number")
      ? [...data].sort((a, b) => a.index! - b.index!)
      : data;
    return ordered.map((d) => d.embedding);
  }
}

// ---------------------------------------------------------------------------
// Gemini (generativelanguage batchEmbedContents)
// ---------------------------------------------------------------------------

class GeminiEmbeddings implements EmbeddingProvider {
  readonly id: string;
  private readonly base: string;

  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    apiBase: string,
  ) {
    this.base = trimBase(apiBase);
    this.id = `gemini:${model}:${this.base}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const modelPath = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
    const url = `${this.base}/${modelPath}:batchEmbedContents?key=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((t) => ({ model: modelPath, content: { parts: [{ text: t }] } })),
      }),
    });
    if (!res.ok) {
      throw new Error(`gemini embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { embeddings?: Array<{ values: number[] }> };
    return (json.embeddings ?? []).map((e) => e.values);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an embedding provider from config, or `null` when embeddings are
 * disabled/unconfigured (index then runs keyword-only). `provider: "auto"`
 * selects by which key is present, preferring OpenAI, then Gemini, then Voyage.
 */
export function createEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider | null {
  const provider = (cfg.provider || "auto").toLowerCase();
  if (provider === "none") return null;

  const key = cfg.apiKey?.trim();

  try {
    switch (provider) {
      case "openai":
        return key
          ? new OpenAICompatEmbeddings("openai", cfg.model, key, cfg.apiBase || OPENAI_DEFAULT_BASE)
          : null;
      case "voyage":
        return key
          ? new OpenAICompatEmbeddings("voyage", cfg.model, key, cfg.apiBase || VOYAGE_DEFAULT_BASE)
          : null;
      case "openai-compatible":
      case "custom":
        return key && cfg.apiBase
          ? new OpenAICompatEmbeddings("custom", cfg.model, key, cfg.apiBase)
          : null;
      case "gemini":
        return key
          ? new GeminiEmbeddings(cfg.model, key, cfg.apiBase || GEMINI_DEFAULT_BASE)
          : null;
      case "auto":
        // Caller resolves the key for whichever provider it wants under "auto";
        // if a key is present, treat it as OpenAI-shaped unless a base hints Gemini.
        if (!key) return null;
        return new OpenAICompatEmbeddings(
          "openai",
          cfg.model,
          key,
          cfg.apiBase || OPENAI_DEFAULT_BASE,
        );
      default:
        logger.warn({ provider }, "unknown embedding provider; running keyword-only memory search");
        return null;
    }
  } catch (err) {
    logger.warn({ err, provider }, "failed to construct embedding provider; keyword-only search");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vector math (JS cosine — used because Bun's sqlite lacks sqlite-vec loading)
// ---------------------------------------------------------------------------

/** Cosine similarity of two equal-length vectors. Returns 0 on mismatch/zero. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Pack a float vector into a compact Float32 blob for SQLite storage. */
export function packVector(vec: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vec).buffer);
}

/** Unpack a Float32 blob back into a number[]. */
export function unpackVector(blob: Uint8Array | ArrayBuffer): number[] {
  const buf =
    blob instanceof Uint8Array
      ? blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)
      : blob;
  return Array.from(new Float32Array(buf));
}
