/**
 * Best-effort per-model USD pricing, used only to estimate session cost for
 * the `/usage` command and API responses. Matched by substring against the
 * model name (same convention as `getModelOverride` in registry.ts),
 * case-insensitive, first match wins.
 *
 * Not authoritative — provider pricing changes over time and this table is
 * not kept in sync automatically. Models without an entry report cost as
 * "unknown" (see estimateCostUsd) rather than silently showing $0.00, so a
 * missing entry doesn't look like a free model.
 */

export interface ModelPricing {
  /** USD per 1M input/prompt tokens (uncached). */
  inputPerM: number;
  /** USD per 1M output/completion tokens. */
  outputPerM: number;
  /** USD per 1M cached-read input tokens. Defaults to inputPerM if omitted. */
  cachedInputPerM?: number;
}

const PRICING_TABLE: readonly (readonly [string, ModelPricing])[] = [
  // Anthropic
  ["claude-opus-4", { inputPerM: 15, outputPerM: 75, cachedInputPerM: 1.5 }],
  ["claude-sonnet-4", { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3 }],
  ["claude-haiku-4", { inputPerM: 0.8, outputPerM: 4, cachedInputPerM: 0.08 }],
  ["claude-3-7-sonnet", { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3 }],
  ["claude-3-5-sonnet", { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3 }],
  ["claude-3-5-haiku", { inputPerM: 0.8, outputPerM: 4, cachedInputPerM: 0.08 }],
  ["claude-3-opus", { inputPerM: 15, outputPerM: 75, cachedInputPerM: 1.5 }],
  ["claude-3-haiku", { inputPerM: 0.25, outputPerM: 1.25, cachedInputPerM: 0.03 }],

  // OpenAI
  ["gpt-4o-mini", { inputPerM: 0.15, outputPerM: 0.6, cachedInputPerM: 0.075 }],
  ["gpt-4o", { inputPerM: 2.5, outputPerM: 10, cachedInputPerM: 1.25 }],
  ["gpt-4.1-mini", { inputPerM: 0.4, outputPerM: 1.6, cachedInputPerM: 0.1 }],
  ["gpt-4.1-nano", { inputPerM: 0.1, outputPerM: 0.4, cachedInputPerM: 0.025 }],
  ["gpt-4.1", { inputPerM: 2, outputPerM: 8, cachedInputPerM: 0.5 }],
  ["o3-mini", { inputPerM: 1.1, outputPerM: 4.4, cachedInputPerM: 0.55 }],
  ["o3", { inputPerM: 10, outputPerM: 40, cachedInputPerM: 2.5 }],
  ["o1-mini", { inputPerM: 1.1, outputPerM: 4.4 }],
  ["o1", { inputPerM: 15, outputPerM: 60, cachedInputPerM: 7.5 }],

  // DeepSeek
  ["deepseek-reasoner", { inputPerM: 0.55, outputPerM: 2.19, cachedInputPerM: 0.14 }],
  ["deepseek-chat", { inputPerM: 0.27, outputPerM: 1.1, cachedInputPerM: 0.07 }],

  // Gemini
  ["gemini-1.5-pro", { inputPerM: 1.25, outputPerM: 5 }],
  ["gemini-1.5-flash", { inputPerM: 0.075, outputPerM: 0.3 }],
  ["gemini-2.0-flash", { inputPerM: 0.1, outputPerM: 0.4 }],

  // Mistral
  ["mistral-large", { inputPerM: 2, outputPerM: 6 }],
  ["mistral-small", { inputPerM: 0.2, outputPerM: 0.6 }],

  // Groq-hosted (approximate, varies by underlying model)
  ["llama-3.1-70b", { inputPerM: 0.59, outputPerM: 0.79 }],
  ["llama-3.1-8b", { inputPerM: 0.05, outputPerM: 0.08 }],
];

export function findPricing(model: string): ModelPricing | null {
  const lower = model.toLowerCase();
  for (const [pattern, pricing] of PRICING_TABLE) {
    if (lower.includes(pattern)) return pricing;
  }
  return null;
}

/**
 * Estimate USD cost for one call's token usage. Returns 0 when the model
 * has no pricing entry — callers should treat 0 as "unknown", not "free"
 * (see formatUsageSummary in agent/usage.ts, which distinguishes the two).
 *
 * Note: this treats all non-completion tokens as either "cached-read" or
 * "prompt" — it does not separately account for Anthropic's higher
 * cache-*write* rate (cache_creation_input_tokens), which is folded into
 * prompt_tokens upstream. That's a real simplification for Anthropic calls
 * that create new cache entries; treat the estimate as approximate.
 */
export function estimateCostUsd(
  model: string,
  tokens: { promptTokens: number; completionTokens: number; cachedTokens: number },
): number {
  const pricing = findPricing(model);
  if (!pricing) return 0;

  const uncachedPrompt = Math.max(0, tokens.promptTokens - tokens.cachedTokens);
  const promptCost = (uncachedPrompt / 1_000_000) * pricing.inputPerM;
  const cachedCost = (tokens.cachedTokens / 1_000_000) * (pricing.cachedInputPerM ?? pricing.inputPerM);
  const completionCost = (tokens.completionTokens / 1_000_000) * pricing.outputPerM;
  return promptCost + cachedCost + completionCost;
}
