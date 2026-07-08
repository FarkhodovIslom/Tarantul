/**
 * Wiring helpers for the long-term memory tools: resolve an embedding
 * config from the app config (reusing LLM provider keys / env), then build the
 * shared `MemorySearchService` that backs `memory_search` / `memory_get`.
 */

import type { Config } from "../config/schema.js";
import { type EmbeddingConfig, createEmbeddingProvider } from "./memory-embeddings.js";
import type { MemoryIndexOptions } from "./memory-index.js";
import { MemorySearchService } from "./tools/memory.js";

function env(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return "";
}

/**
 * Resolve which embedding provider/key to use. Explicit `tools.memory.apiKey`
 * wins; otherwise the key is pulled from the matching provider config or a
 * conventional env var. `provider: "auto"` prefers OpenAI, then Gemini.
 */
export function resolveEmbeddingConfig(cfg: Config): EmbeddingConfig {
  const mem = cfg.tools.memory;
  const providers = cfg.providers;
  const explicitKey = mem.apiKey?.trim() ?? "";

  const pick = (provider: string, key: string, apiBase?: string | null): EmbeddingConfig => ({
    provider,
    model: mem.model,
    apiKey: explicitKey || key,
    apiBase: mem.apiBase ?? apiBase ?? null,
  });

  switch ((mem.provider || "auto").toLowerCase()) {
    case "openai":
      return pick(
        "openai",
        providers.openai.apiKey || env("OPENAI_API_KEY"),
        providers.openai.apiBase,
      );
    case "gemini":
      return pick(
        "gemini",
        providers.gemini.apiKey || env("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        providers.gemini.apiBase,
      );
    case "voyage":
      return pick("voyage", env("VOYAGE_API_KEY"));
    case "openai-compatible":
    case "custom":
      return pick(
        "openai-compatible",
        providers.custom.apiKey || env("OPENAI_API_KEY"),
        providers.custom.apiBase,
      );
    case "none":
      return { provider: "none", model: mem.model, apiKey: "", apiBase: null };
    default: {
      // auto: prefer an OpenAI key, then Gemini.
      const openaiKey = providers.openai.apiKey || env("OPENAI_API_KEY");
      if (openaiKey) return pick("openai", openaiKey, providers.openai.apiBase);
      const geminiKey = providers.gemini.apiKey || env("GEMINI_API_KEY", "GOOGLE_API_KEY");
      if (geminiKey)
        return {
          provider: "gemini",
          model: "text-embedding-004",
          apiKey: geminiKey,
          apiBase: providers.gemini.apiBase ?? null,
        };
      return { provider: "none", model: mem.model, apiKey: "", apiBase: null };
    }
  }
}

/** Build the shared memory service (embedder + index options) from config. */
export function buildMemoryService(cfg: Config, workspace: string): MemorySearchService {
  const mem = cfg.tools.memory;
  const embedder = createEmbeddingProvider(resolveEmbeddingConfig(cfg));
  const indexOptions: MemoryIndexOptions = {
    vectorWeight: mem.vectorWeight,
    textWeight: mem.textWeight,
    chunkMaxTokens: mem.chunkMaxTokens,
    chunkOverlapTokens: mem.chunkOverlapTokens,
    decayHalfLifeDays: mem.decayHalfLifeDays,
    mmrLambda: mem.mmrLambda,
    graphExpansion: mem.graphExpansion,
    graphBoost: mem.graphBoost,
    graphNeighborLimit: mem.graphNeighborLimit,
  };
  return new MemorySearchService(workspace, embedder, indexOptions);
}
