
import type { Config } from "../config/schema.js";
import { getApiBase, getApiKey, getProviderName } from "../config/schema.js";
import type { LLMProvider } from "./base.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai_compat.js";
import { findByName } from "./registry.js";

export function createProvider(config: Config, model?: string): LLMProvider {
  const providerName = getProviderName(config, model);
  const apiKey = getApiKey(config, model);
  const apiBase = getApiBase(config, model);
  const spec = providerName ? findByName(providerName) : null;

  const providers = config.providers as Record<string, { apiKey?: string; extraHeaders?: Record<string, string> | null }>;
  const providerCfg = providerName ? providers[providerName] : null;
  const extraHeaders = providerCfg?.extraHeaders ?? null;

  const effectiveModel = model ?? config.agents.defaults.model;

  if (!spec) {
    return new OpenAICompatProvider({ apiKey, apiBase, defaultModel: effectiveModel, extraHeaders: extraHeaders ?? null });
  }

  switch (spec.backend) {
    case "anthropic":
      return new AnthropicProvider({
        apiKey,
        apiBase,
        defaultModel: effectiveModel,
        extraHeaders: extraHeaders ?? null,
      });

    case "openai_compat":
    default:
      return new OpenAICompatProvider({
        apiKey,
        apiBase,
        defaultModel: effectiveModel,
        extraHeaders: extraHeaders ?? null,
        spec,
      });
  }
}
