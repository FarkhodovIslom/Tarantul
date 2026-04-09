/**
 * OpenAI-compatible API request/response types.
 * Only the subset nanobot actually uses — keeps the type surface small.
 */

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

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
  /** nanobot extension: route request to a named session */
  session_id?: string;
  temperature?: number;
  max_tokens?: number;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

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
  /** Called before each turn to get the current system prompt (with memory + skills). */
  getSystemPrompt?: (() => string) | null;
  /** Workspace path (for channel metadata) */
  workspace?: string | null;
}
