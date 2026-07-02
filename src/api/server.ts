import { randomBytes } from "node:crypto";
import { buildMessages } from "../agent/context.js";
import { EMPTY_FINAL_RESPONSE_MESSAGE } from "../utils/runtime.js";
import { logger } from "../utils/logger.js";
import type { AgentRunner, AgentRunSpec } from "../agent/runner.js";
import type { SessionManager } from "../session/manager.js";
import type { ToolRegistry } from "../agent/tools/registry.js";
import type {
  ApiServerOpts,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ErrorBody,
  ModelListResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_CHANNEL = "api";
const API_CHAT_ID = "default";
const DEFAULT_SESSION_KEY = "api:default";

// ---------------------------------------------------------------------------
// Async mutex — one active request per session key
// ---------------------------------------------------------------------------

/**
 * Simple Promise-chain mutex.
 * Each `acquire()` call resolves when all previous holders have released.
 * Returns a `release` function the caller must invoke when done.
 */
class Mutex {
  private _tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = this._tail.then(() => release);
    this._tail = this._tail.then(() => next);
    return acquired;
  }
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, message: string, type = "invalid_request_error"): Response {
  const body: ErrorBody = { error: { message, type, code: status } };
  return jsonResponse(body, status);
}

function chatCompletionResponse(content: string, model: string): ChatCompletionResponse {
  return {
    id: `chatcmpl-${randomBytes(6).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract plain text from a ChatMessage content (string or parts array). */
function extractText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join(" ");
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

async function handleChatCompletions(
  req: Request,
  opts: ApiServerOpts,
  runner: AgentRunner,
  sessions: SessionManager,
  tools: ToolRegistry,
  runSpec: Omit<AgentRunSpec, "initialMessages">,
  mutexes: Map<string, Mutex>,
): Promise<Response> {
  // Auth
  if (opts.apiKey) {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (token !== opts.apiKey) {
      return errorResponse(401, "Invalid API key", "authentication_error");
    }
  }

  // Parse body
  let body: ChatCompletionRequest;
  try {
    body = (await req.json()) as ChatCompletionRequest;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  // Validate messages
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(400, "messages must be a non-empty array");
  }

  // Streaming not yet implemented
  if (body.stream) {
    return errorResponse(400, "stream=true is not supported. Set stream=false or omit it.");
  }

  // Model check
  if (body.model && body.model !== opts.modelName) {
    return errorResponse(400, `Only configured model '${opts.modelName}' is available`);
  }

  // Extract the last user message (API callers may send history; take last user turn)
  const userMessages = body.messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) {
    return errorResponse(400, "At least one user message is required");
  }
  const lastUser = userMessages[userMessages.length - 1]!;
  const userContent = extractText(lastUser);
  if (!userContent.trim()) {
    return errorResponse(400, "User message content must not be empty");
  }

  // Session routing
  const sessionKey = body.session_id ? `api:${body.session_id}` : DEFAULT_SESSION_KEY;

  // Per-session mutex
  if (!mutexes.has(sessionKey)) mutexes.set(sessionKey, new Mutex());
  const mutex = mutexes.get(sessionKey)!;
  const release = await mutex.acquire();

  logger.info({ sessionKey, content: userContent.slice(0, 80) }, "api request");

  // The turn runs to completion regardless of the HTTP timeout. We must not
  // release the session mutex until it actually settles — otherwise a timed-out
  // turn keeps mutating session state while the next request runs concurrently,
  // defeating the per-session serialization the mutex exists to provide.
  const turn = runTurn(
    userContent, sessionKey, runner, sessions, tools, runSpec, opts.modelName, opts.getSystemPrompt,
  );
  turn.catch(() => { /* surfaced below / on the timeout path */ })
    .finally(() => release());

  try {
    const responseText = await withTimeout(turn, opts.timeoutSecs * 1000);
    return jsonResponse(chatCompletionResponse(responseText, opts.modelName));
  } catch (err) {
    if (err instanceof TimeoutError) {
      return errorResponse(504, `Request timed out after ${opts.timeoutSecs}s`, "timeout_error");
    }
    logger.error({ err, sessionKey }, "api error");
    return errorResponse(500, "Internal server error", "server_error");
  }
}

async function runTurn(
  userContent: string,
  sessionKey: string,
  runner: AgentRunner,
  sessions: SessionManager,
  tools: ToolRegistry,
  runSpec: Omit<AgentRunSpec, "initialMessages">,
  modelName: string,
  getSystemPrompt: (() => string) | null | undefined,
): Promise<string> {
  const session = sessions.getOrCreate(sessionKey);
  const history = session.getHistory(0);

  const systemPrompt = getSystemPrompt?.() ?? "You are a helpful AI assistant.";
  const messages = buildMessages({
    history,
    currentMessage: userContent,
    systemPrompt,
    channel: API_CHANNEL,
    chatId: API_CHAT_ID,
  });

  const result = await runner.run({ ...runSpec, initialMessages: messages });
  let text = result.finalContent?.trim() ?? "";

  // Retry once on empty
  if (!text) {
    logger.warn({ sessionKey }, "empty response, retrying once");
    const retry = await runner.run({ ...runSpec, initialMessages: messages });
    text = retry.finalContent?.trim() ?? "";
  }

  // Persist whatever was actually returned to the caller — including the
  // retry's answer or the fallback message — so the session's history stays
  // consistent with what the user saw. Persisting only after the retry
  // resolves also avoids a user message with no matching assistant reply.
  const finalText = text || EMPTY_FINAL_RESPONSE_MESSAGE;
  session.addMessage("user", userContent);
  session.addMessage("assistant", finalText);
  await sessions.save(session);

  return finalText;
}

async function handleModels(opts: ApiServerOpts): Promise<Response> {
  const body: ModelListResponse = {
    object: "list",
    data: [
      {
        id: opts.modelName,
        object: "model",
        created: 0,
        owned_by: "tarantul",
      },
    ],
  };
  return jsonResponse(body);
}

async function handleHealth(): Promise<Response> {
  return jsonResponse({ status: "ok" });
}

// ---------------------------------------------------------------------------
// Timeout utility
// ---------------------------------------------------------------------------

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ---------------------------------------------------------------------------
// ApiServer
// ---------------------------------------------------------------------------

export class ApiServer {
  private _server: ReturnType<typeof Bun.serve> | null = null;
  private readonly _mutexes = new Map<string, Mutex>();

  constructor(
    private readonly _opts: ApiServerOpts,
    private readonly _runner: AgentRunner,
    private readonly _sessions: SessionManager,
    private readonly _tools: ToolRegistry,
    private readonly _runSpec: Omit<AgentRunSpec, "initialMessages">,
  ) {}

  start(): void {
    const { host, port } = this._opts;
    const opts = this._opts;
    const runner = this._runner;
    const sessions = this._sessions;
    const tools = this._tools;
    const runSpec = this._runSpec;
    const mutexes = this._mutexes;

    this._server = Bun.serve({
      hostname: host,
      port,
      fetch: async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method.toUpperCase();

        if (method === "POST" && path === "/v1/chat/completions") {
          return handleChatCompletions(req, opts, runner, sessions, tools, runSpec, mutexes);
        }
        if (method === "GET" && path === "/v1/models") {
          return handleModels(opts);
        }
        if (method === "GET" && (path === "/health" || path === "/")) {
          return handleHealth();
        }
        // OPTIONS pre-flight (basic CORS)
        if (method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type,Authorization",
            },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    logger.info({ host, port }, "api server started");
  }

  stop(): void {
    this._server?.stop();
    this._server = null;
  }

  get port(): number {
    return this._server?.port ?? this._opts.port;
  }

  get url(): string {
    return `http://${this._opts.host}:${this.port}`;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and start an ApiServer from config + runtime components.
 * The caller is responsible for stopping the server when done.
 */
export function startApiServer(
  opts: ApiServerOpts,
  runner: AgentRunner,
  sessions: SessionManager,
  tools: ToolRegistry,
  runSpec: Omit<AgentRunSpec, "initialMessages">,
): ApiServer {
  const server = new ApiServer(opts, runner, sessions, tools, runSpec);
  server.start();
  return server;
}
