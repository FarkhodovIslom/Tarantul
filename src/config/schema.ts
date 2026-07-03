
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** camelCase ↔ snake_case alias support via .transform() on input */
function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Preprocess object keys: accept both snake_case and camelCase.
 * Converts all snake_case keys to camelCase before validation.
 */
function withAliases<T extends z.ZodTypeAny>(schema: T): T {
  return z.preprocess((input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[camel(k)] = v;
    }
    return out;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }, schema) as unknown as T;
}

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

export const ChannelsConfigSchema = withAliases(
  z
    .object({
      sendProgress: z.boolean().default(true),
      sendToolHints: z.boolean().default(false),
      sendMaxRetries: z.number().int().min(0).max(10).default(3),
    })
    .passthrough(), // allow per-channel extra fields
);

export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;

export const AgentDefaultsSchema = withAliases(
  z.object({
    workspace: z.string().default("~/.tarantul/workspace"),
    model: z.string().default("anthropic/claude-opus-4-5"),
    provider: z.string().default("auto"),
    maxTokens: z.number().int().positive().default(8192),
    contextWindowTokens: z.number().int().positive().default(65_536),
    contextBlockLimit: z.number().int().positive().nullable().default(null),
    temperature: z.number().min(0).max(2).default(0.1),
    maxToolIterations: z.number().int().positive().default(200),
    maxToolResultChars: z.number().int().positive().default(16_000),
    providerRetryMode: z.enum(["standard", "persistent"]).default("standard"),
    reasoningEffort: z.enum(["low", "medium", "high"]).nullable().default(null),
    timezone: z.string().default("UTC"),
  }),
);

export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;

export const AgentsConfigSchema = withAliases(
  z.object({
    defaults: AgentDefaultsSchema.default({}),
  }),
);

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

export const ProviderConfigSchema = withAliases(
  z.object({
    apiKey: z.string().default(""),
    apiBase: z.string().nullable().default(null),
    extraHeaders: z.record(z.string()).nullable().default(null),
  }),
);

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ProvidersConfigSchema = withAliases(
  z.object({
    custom: ProviderConfigSchema.default({}),
    azureOpenai: ProviderConfigSchema.default({}),
    anthropic: ProviderConfigSchema.default({}),
    openai: ProviderConfigSchema.default({}),
    openrouter: ProviderConfigSchema.default({}),
    deepseek: ProviderConfigSchema.default({}),
    groq: ProviderConfigSchema.default({}),
    zhipu: ProviderConfigSchema.default({}),
    dashscope: ProviderConfigSchema.default({}),
    vllm: ProviderConfigSchema.default({}),
    ollama: ProviderConfigSchema.default({}),
    ovms: ProviderConfigSchema.default({}),
    gemini: ProviderConfigSchema.default({}),
    moonshot: ProviderConfigSchema.default({}),
    minimax: ProviderConfigSchema.default({}),
    mistral: ProviderConfigSchema.default({}),
    stepfun: ProviderConfigSchema.default({}),
    aihubmix: ProviderConfigSchema.default({}),
    siliconflow: ProviderConfigSchema.default({}),
    volcengine: ProviderConfigSchema.default({}),
    volcengineCodingPlan: ProviderConfigSchema.default({}),
    byteplus: ProviderConfigSchema.default({}),
    byteplusCodingPlan: ProviderConfigSchema.default({}),
    openaiCodex: ProviderConfigSchema.default({}),
    githubCopilot: ProviderConfigSchema.default({}),
  }),
);

export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

export const HeartbeatConfigSchema = withAliases(
  z.object({
    enabled: z.boolean().default(true),
    intervalS: z.number().int().positive().default(30 * 60),
    keepRecentMessages: z.number().int().positive().default(8),
  }),
);

export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;

export const ApiConfigSchema = withAliases(
  z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(8900),
    timeout: z.number().positive().default(120.0),
    /** Bearer token clients must supply. Empty means the API is unauthenticated. */
    apiKey: z.string().default(""),
  }),
);

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export const GatewayConfigSchema = withAliases(
  z.object({
    host: z.string().default("0.0.0.0"),
    port: z.number().int().min(1).max(65535).default(18790),
    heartbeat: HeartbeatConfigSchema.default({}),
  }),
);

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const WebSearchConfigSchema = withAliases(
  z.object({
    provider: z.string().default("brave"),
    apiKey: z.string().default(""),
    baseUrl: z.string().default(""),
    maxResults: z.number().int().positive().default(5),
  }),
);

export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>;

export const WebToolsConfigSchema = withAliases(
  z.object({
    enable: z.boolean().default(true),
    proxy: z.string().nullable().default(null),
    search: WebSearchConfigSchema.default({}),
  }),
);

export type WebToolsConfig = z.infer<typeof WebToolsConfigSchema>;

export const ExecToolConfigSchema = withAliases(
  z.object({
    enable: z.boolean().default(true),
    timeout: z.number().int().positive().default(60),
    pathAppend: z.string().default(""),
  }),
);

export type ExecToolConfig = z.infer<typeof ExecToolConfigSchema>;

export const MCPServerConfigSchema = withAliases(
  z.object({
    type: z.enum(["stdio", "sse", "streamableHttp"]).nullable().default(null),
    command: z.string().default(""),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    url: z.string().default(""),
    headers: z.record(z.string()).default({}),
    toolTimeout: z.number().int().positive().default(30),
    enabledTools: z.array(z.string()).default(["*"]),
  }),
);

export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

export const ToolsConfigSchema = withAliases(
  z.object({
    web: WebToolsConfigSchema.default({}),
    exec: ExecToolConfigSchema.default({}),
    restrictToWorkspace: z.boolean().default(false),
    mcpServers: z.record(MCPServerConfigSchema).default({}),
  }),
);

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export const ConfigSchema = withAliases(
  z.object({
    agents: AgentsConfigSchema.default({}),
    channels: ChannelsConfigSchema.default({}),
    providers: ProvidersConfigSchema.default({}),
    api: ApiConfigSchema.default({}),
    gateway: GatewayConfigSchema.default({}),
    tools: ToolsConfigSchema.default({}),
  }),
);

export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Provider matching helpers (mirrors Config._match_provider / get_provider_*)
// ---------------------------------------------------------------------------

import { PROVIDERS, findByName } from "../providers/registry.js";

export function matchProvider(
  config: Config,
  model?: string,
): { providerConfig: ProviderConfig | null; providerName: string | null } {
  const forced = config.agents.defaults.provider;

  if (forced !== "auto") {
    const spec = findByName(forced);
    if (spec) {
      const p = (config.providers as Record<string, ProviderConfig>)[spec.name] ?? null;
      return p ? { providerConfig: p, providerName: spec.name } : { providerConfig: null, providerName: null };
    }
    return { providerConfig: null, providerName: null };
  }

  const modelStr = (model ?? config.agents.defaults.model).toLowerCase();
  const modelNormalized = modelStr.replace(/-/g, "_");
  const modelPrefix = modelStr.includes("/") ? modelStr.split("/")[0]! : "";
  const normalizedPrefix = modelPrefix.replace(/-/g, "_");

  const kwMatches = (kw: string) => {
    kw = kw.toLowerCase();
    return kw.includes(modelStr) || kw === modelStr || modelStr.includes(kw) || modelNormalized.includes(kw.replace(/-/g, "_"));
  };

  const providers = config.providers as Record<string, ProviderConfig>;

  // Explicit provider prefix wins
  for (const spec of PROVIDERS) {
    const p = providers[spec.name];
    if (p && modelPrefix && normalizedPrefix === spec.name) {
      if (spec.isOauth || spec.isLocal || p.apiKey) {
        return { providerConfig: p, providerName: spec.name };
      }
    }
  }

  // Match by keyword
  for (const spec of PROVIDERS) {
    const p = providers[spec.name];
    if (p && spec.keywords.some(kwMatches)) {
      if (spec.isOauth || spec.isLocal || p.apiKey) {
        return { providerConfig: p, providerName: spec.name };
      }
    }
  }

  // Local fallback
  let localFallback: { providerConfig: ProviderConfig; providerName: string } | null = null;
  for (const spec of PROVIDERS) {
    if (!spec.isLocal) continue;
    const p = providers[spec.name];
    if (!(p?.apiBase)) continue;
    if (spec.detectByBaseKeyword && p.apiBase.includes(spec.detectByBaseKeyword)) {
      return { providerConfig: p, providerName: spec.name };
    }
    if (!localFallback) localFallback = { providerConfig: p, providerName: spec.name };
  }
  if (localFallback) return localFallback;

  // Final fallback: first provider with api_key (no OAuth)
  for (const spec of PROVIDERS) {
    if (spec.isOauth) continue;
    const p = providers[spec.name];
    if (p?.apiKey) return { providerConfig: p, providerName: spec.name };
  }

  return { providerConfig: null, providerName: null };
}

export function getProvider(config: Config, model?: string): ProviderConfig | null {
  return matchProvider(config, model).providerConfig;
}

export function getProviderName(config: Config, model?: string): string | null {
  return matchProvider(config, model).providerName;
}

export function getApiKey(config: Config, model?: string): string | null {
  const p = getProvider(config, model);
  return p?.apiKey || null;
}

export function getApiBase(config: Config, model?: string): string | null {
  const { providerConfig: p, providerName: name } = matchProvider(config, model);
  if (p?.apiBase) return p.apiBase;
  if (name) {
    const spec = findByName(name);
    if (spec && (spec.isGateway || spec.isLocal) && spec.defaultApiBase) {
      return spec.defaultApiBase;
    }
  }
  return null;
}

export function getWorkspacePath(config: Config): string {
  const raw = config.agents.defaults.workspace;
  return raw.startsWith("~/") ? raw.replace("~", process.env["HOME"] ?? "") : raw;
}
