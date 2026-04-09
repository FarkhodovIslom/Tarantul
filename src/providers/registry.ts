/**
 * Provider Registry — single source of truth for LLM provider metadata.
 * Mirrors nanobot/providers/registry.py
 *
 * Adding a new provider:
 *   1. Add a ProviderSpec to PROVIDERS below.
 *   2. Add a field to ProvidersConfig in config/schema.ts.
 *   Done. Provider matching and status display all derive from here.
 *
 * Order matters — it controls match priority and fallback. Gateways first.
 */

export interface ModelOverride {
  temperature?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface ProviderSpec {
  // identity
  readonly name: string;
  readonly keywords: readonly string[];
  readonly envKey: string;
  readonly displayName: string;

  // which provider implementation to use
  // "openai_compat" | "anthropic" | "azure_openai" | "openai_codex" | "github_copilot"
  readonly backend: "openai_compat" | "anthropic" | "azure_openai" | "openai_codex" | "github_copilot";

  // extra env vars: [["VAR_NAME", "{api_key}"]]
  readonly envExtras: readonly (readonly [string, string])[];

  // gateway / local detection
  readonly isGateway: boolean;
  readonly isLocal: boolean;
  readonly detectByKeyPrefix: string;
  readonly detectByBaseKeyword: string;
  readonly defaultApiBase: string;

  // gateway behavior
  readonly stripModelPrefix: boolean;
  readonly supportsMaxCompletionTokens: boolean;

  // per-model param overrides
  readonly modelOverrides: readonly (readonly [string, ModelOverride])[];

  readonly isOauth: boolean;
  readonly isDirect: boolean;
  readonly supportsPromptCaching: boolean;

  readonly label: string;
}

function spec(
  overrides: Partial<ProviderSpec> & Pick<ProviderSpec, "name" | "keywords" | "envKey">,
): ProviderSpec {
  const s: ProviderSpec = {
    displayName: "",
    backend: "openai_compat",
    envExtras: [],
    isGateway: false,
    isLocal: false,
    detectByKeyPrefix: "",
    detectByBaseKeyword: "",
    defaultApiBase: "",
    stripModelPrefix: false,
    supportsMaxCompletionTokens: false,
    modelOverrides: [],
    isOauth: false,
    isDirect: false,
    supportsPromptCaching: false,
    ...overrides,
    get label() {
      return (this.displayName || this.name).replace(/^./, (c) => c.toUpperCase());
    },
  };
  return s;
}

// ---------------------------------------------------------------------------
// PROVIDERS — the registry. Order = priority.
// ---------------------------------------------------------------------------

export const PROVIDERS: readonly ProviderSpec[] = [
  // === Custom (direct OpenAI-compatible endpoint) ==========================
  spec({
    name: "custom",
    keywords: [],
    envKey: "",
    displayName: "Custom",
    backend: "openai_compat",
    isDirect: true,
  }),

  // === Azure OpenAI =========================================================
  spec({
    name: "azureOpenai",
    keywords: ["azure", "azure-openai"],
    envKey: "",
    displayName: "Azure OpenAI",
    backend: "azure_openai",
    isDirect: true,
  }),

  // === Gateways =============================================================
  spec({
    name: "openrouter",
    keywords: ["openrouter"],
    envKey: "OPENROUTER_API_KEY",
    displayName: "OpenRouter",
    backend: "openai_compat",
    isGateway: true,
    detectByKeyPrefix: "sk-or-",
    detectByBaseKeyword: "openrouter",
    defaultApiBase: "https://openrouter.ai/api/v1",
    supportsPromptCaching: true,
  }),
  spec({
    name: "aihubmix",
    keywords: ["aihubmix"],
    envKey: "OPENAI_API_KEY",
    displayName: "AiHubMix",
    backend: "openai_compat",
    isGateway: true,
    detectByBaseKeyword: "aihubmix",
    defaultApiBase: "https://aihubmix.com/v1",
    stripModelPrefix: true,
  }),
  spec({
    name: "siliconflow",
    keywords: ["siliconflow"],
    envKey: "OPENAI_API_KEY",
    displayName: "SiliconFlow",
    backend: "openai_compat",
    isGateway: true,
    detectByBaseKeyword: "siliconflow",
    defaultApiBase: "https://api.siliconflow.cn/v1",
  }),
  spec({
    name: "volcengine",
    keywords: ["volcengine", "volces", "ark"],
    envKey: "OPENAI_API_KEY",
    displayName: "VolcEngine",
    backend: "openai_compat",
    isGateway: true,
    detectByBaseKeyword: "volces",
    defaultApiBase: "https://ark.cn-beijing.volces.com/api/v3",
  }),
  spec({
    name: "volcengineCodingPlan",
    keywords: ["volcengine-plan"],
    envKey: "OPENAI_API_KEY",
    displayName: "VolcEngine Coding Plan",
    backend: "openai_compat",
    isGateway: true,
    defaultApiBase: "https://ark.cn-beijing.volces.com/api/coding/v3",
    stripModelPrefix: true,
  }),
  spec({
    name: "byteplus",
    keywords: ["byteplus"],
    envKey: "OPENAI_API_KEY",
    displayName: "BytePlus",
    backend: "openai_compat",
    isGateway: true,
    detectByBaseKeyword: "bytepluses",
    defaultApiBase: "https://ark.ap-southeast.bytepluses.com/api/v3",
    stripModelPrefix: true,
  }),
  spec({
    name: "byteplusCodingPlan",
    keywords: ["byteplus-plan"],
    envKey: "OPENAI_API_KEY",
    displayName: "BytePlus Coding Plan",
    backend: "openai_compat",
    isGateway: true,
    defaultApiBase: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
    stripModelPrefix: true,
  }),

  // === Standard providers ===================================================
  spec({
    name: "anthropic",
    keywords: ["anthropic", "claude"],
    envKey: "ANTHROPIC_API_KEY",
    displayName: "Anthropic",
    backend: "anthropic",
    supportsPromptCaching: true,
  }),
  spec({
    name: "openai",
    keywords: ["openai", "gpt"],
    envKey: "OPENAI_API_KEY",
    displayName: "OpenAI",
    backend: "openai_compat",
  }),
  spec({
    name: "openaiCodex",
    keywords: ["openai-codex"],
    envKey: "",
    displayName: "OpenAI Codex",
    backend: "openai_codex",
    detectByBaseKeyword: "codex",
    defaultApiBase: "https://chatgpt.com/backend-api",
    isOauth: true,
  }),
  spec({
    name: "githubCopilot",
    keywords: ["github_copilot", "copilot"],
    envKey: "",
    displayName: "Github Copilot",
    backend: "github_copilot",
    defaultApiBase: "https://api.githubcopilot.com",
    stripModelPrefix: true,
    isOauth: true,
  }),
  spec({
    name: "deepseek",
    keywords: ["deepseek"],
    envKey: "DEEPSEEK_API_KEY",
    displayName: "DeepSeek",
    backend: "openai_compat",
    defaultApiBase: "https://api.deepseek.com",
  }),
  spec({
    name: "gemini",
    keywords: ["gemini"],
    envKey: "GEMINI_API_KEY",
    displayName: "Gemini",
    backend: "openai_compat",
    defaultApiBase: "https://generativelanguage.googleapis.com/v1beta/openai/",
  }),
  spec({
    name: "zhipu",
    keywords: ["zhipu", "glm", "zai"],
    envKey: "ZAI_API_KEY",
    displayName: "Zhipu AI",
    backend: "openai_compat",
    envExtras: [["ZHIPUAI_API_KEY", "{api_key}"]],
    defaultApiBase: "https://open.bigmodel.cn/api/paas/v4",
  }),
  spec({
    name: "dashscope",
    keywords: ["qwen", "dashscope"],
    envKey: "DASHSCOPE_API_KEY",
    displayName: "DashScope",
    backend: "openai_compat",
    defaultApiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  }),
  spec({
    name: "moonshot",
    keywords: ["moonshot", "kimi"],
    envKey: "MOONSHOT_API_KEY",
    displayName: "Moonshot",
    backend: "openai_compat",
    defaultApiBase: "https://api.moonshot.ai/v1",
    modelOverrides: [["kimi-k2.5", { temperature: 1.0 }]],
  }),
  spec({
    name: "minimax",
    keywords: ["minimax"],
    envKey: "MINIMAX_API_KEY",
    displayName: "MiniMax",
    backend: "openai_compat",
    defaultApiBase: "https://api.minimax.io/v1",
  }),
  spec({
    name: "mistral",
    keywords: ["mistral"],
    envKey: "MISTRAL_API_KEY",
    displayName: "Mistral",
    backend: "openai_compat",
    defaultApiBase: "https://api.mistral.ai/v1",
  }),
  spec({
    name: "stepfun",
    keywords: ["stepfun", "step"],
    envKey: "STEPFUN_API_KEY",
    displayName: "Step Fun",
    backend: "openai_compat",
    defaultApiBase: "https://api.stepfun.com/v1",
  }),

  // === Local deployment =====================================================
  spec({
    name: "vllm",
    keywords: ["vllm"],
    envKey: "HOSTED_VLLM_API_KEY",
    displayName: "vLLM/Local",
    backend: "openai_compat",
    isLocal: true,
  }),
  spec({
    name: "ollama",
    keywords: ["ollama", "nemotron"],
    envKey: "OLLAMA_API_KEY",
    displayName: "Ollama",
    backend: "openai_compat",
    isLocal: true,
    detectByBaseKeyword: "11434",
    defaultApiBase: "http://localhost:11434/v1",
  }),
  spec({
    name: "ovms",
    keywords: ["openvino", "ovms"],
    envKey: "",
    displayName: "OpenVINO Model Server",
    backend: "openai_compat",
    isDirect: true,
    isLocal: true,
    defaultApiBase: "http://localhost:8000/v3",
  }),

  // === Auxiliary ============================================================
  spec({
    name: "groq",
    keywords: ["groq"],
    envKey: "GROQ_API_KEY",
    displayName: "Groq",
    backend: "openai_compat",
    defaultApiBase: "https://api.groq.com/openai/v1",
  }),
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** camelCase → snake_case for backwards compatibility */
function toSnake(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase();
}

export function findByName(name: string): ProviderSpec | null {
  const normalized = toSnake(name.replace(/-/g, "_")).replace(/^_/, "");
  for (const s of PROVIDERS) {
    if (s.name === name || toSnake(s.name) === normalized) return s;
  }
  return null;
}

export function getModelOverride(spec: ProviderSpec, model: string): ModelOverride | null {
  const modelLower = model.toLowerCase();
  for (const [pattern, overrides] of spec.modelOverrides) {
    if (modelLower.includes(pattern.toLowerCase())) return overrides;
  }
  return null;
}
