
export interface ContentPart {
  type: "text" | "image_url" | string;
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | string;
  content: string | ContentPart[];
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  /** tarantul extension: route request to a named session */
  session_id?: string;
  temperature?: number;
  max_tokens?: number;
}


export interface ChatChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: "stop" | "length" | "tool_calls" | string;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface ModelListResponse {
  object: "list";
  data: ModelObject[];
}

export interface ErrorBody {
  error: { message: string; type: string; code: number };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

export interface ApiServerOpts {
  host: string;
  port: number;
  /** Per-request timeout in seconds */
  timeoutSecs: number;
  /** Model name reported to clients */
  modelName: string;
  /** Optional Bearer token that clients must supply in Authorization header */
  apiKey?: string | null;
  /** Called before each turn to get the current system prompt (with memory + skills) for a session key. */
  getSystemPrompt?: ((key: string) => string) | null;
  /** Wraps each turn so per-session tools (e.g. memory) bind to this key across
   * the turn's whole async tree — safe under concurrent sessions. */
  wrapTurn?: (<T>(key: string, fn: () => Promise<T>) => Promise<T>) | null;
  /** Workspace path (for channel metadata) */
  workspace?: string | null;

  // --- New opts for parity with CLI Agent mode ---

  /** SettingsController for model/settings mutation endpoints. */
  settings?: {
    overview(): Record<string, unknown>;
    setActiveModel(providerName: string, modelId: string): { ok: boolean; error?: string };
    configuredProviders(): { name: string; label: string; modelCount: number }[];
    providerModels(providerName: string): string[];
    setValue(path: string, rawValue: string): { ok: boolean; error?: string };
    getValue(path: string): unknown;
  } | null;

  /** Called after a settings/model change that should rebuild the runner. */
  onProviderRebuild?: (() => void) | null;

  /** Permission registry for tool approval prompts. */
  permissions?: {
    listPending(): Array<{ id: string; request: { tool: string; action: string; reason: string }; sessionKey: string; createdAt: string }>;
    resolve(id: string, allow: boolean): boolean;
  } | null;

  /** Server start timestamp (for /v1/status uptime). */
  startedAt?: number;
}

// ---------------------------------------------------------------------------
// Cancel request
// ---------------------------------------------------------------------------

export interface CancelRequest {
  session_id: string;
}

// ---------------------------------------------------------------------------
// Settings mutation
// ---------------------------------------------------------------------------

export interface SetModelRequest {
  provider: string;
  model: string;
  /** If true, persist the change to config.json (default: false, in-memory only). */
  persist?: boolean;
}

export interface SettingsPatchRequest {
  /** Dotted config path, e.g. "agents.defaults.temperature" */
  path: string;
  value: string;
}
