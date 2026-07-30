import { randomBytes, timingSafeEqual } from "node:crypto";
import { buildMessages } from "../agent/context.js";
import { recordTurnUsage } from "../agent/usage.js";
import { getSessionUsage, formatUsageSummary } from "../agent/usage.js";
import { EMPTY_FINAL_RESPONSE_MESSAGE } from "../utils/runtime.js";
import { logger } from "../utils/logger.js";
import { ServerStreamHook } from "./hook.js";
import type { AgentRunner, AgentRunSpec } from "../agent/runner.js";
import type { SessionManager } from "../session/manager.js";
import type { ToolRegistry } from "../agent/tools/registry.js";
import type {
  ApiServerOpts,
  CancelRequest,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ErrorBody,
  ModelListResponse,
  SetModelRequest,
  SettingsPatchRequest,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_CHANNEL = "api";
const API_CHAT_ID = "default";
const DEFAULT_SESSION_KEY = "api:default";
const VERSION = "0.1.4";

/** Bounds for the client-supplied session_id — see isValidSessionId(). */
const SESSION_ID_MAX_LENGTH = 128;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Max distinct session keys the mutex registry tracks — see MutexRegistry. */
const MAX_TRACKED_SESSIONS = 500;

function isValidSessionId(id: string): boolean {
  return id.length > 0 && id.length <= SESSION_ID_MAX_LENGTH && SESSION_ID_PATTERN.test(id);
}

// ---------------------------------------------------------------------------
// Async mutex — one active request per session key
// ---------------------------------------------------------------------------

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

class MutexRegistry {
  private readonly mutexes = new Map<string, Mutex>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): Mutex {
    const existing = this.mutexes.get(key);
    if (existing) {
      this.mutexes.delete(key);
      this.mutexes.set(key, existing);
      return existing;
    }

    const mutex = new Mutex();
    this.mutexes.set(key, mutex);
    if (this.mutexes.size > this.maxEntries) {
      const oldestKey = this.mutexes.keys().next().value;
      if (oldestKey !== undefined) this.mutexes.delete(oldestKey);
    }
    return mutex;
  }

  get size(): number {
    return this.mutexes.size;
  }
}

// ---------------------------------------------------------------------------
// AbortController registry — tracks in-flight requests per session
// ---------------------------------------------------------------------------

/**
 * Tracks AbortControllers for in-flight requests, keyed by session.
 * When a new request arrives for a session that already has one in flight,
 * the previous one is auto-aborted (verification concern #1: race condition).
 */
class AbortRegistry {
  private readonly controllers = new Map<string, AbortController>();

  /** Create a new controller for this session, aborting any previous one. */
  create(sessionKey: string): AbortController {
    const existing = this.controllers.get(sessionKey);
    if (existing) {
      existing.abort();
      logger.info({ sessionKey }, "auto-aborted previous in-flight request");
    }
    const controller = new AbortController();
    this.controllers.set(sessionKey, controller);
    return controller;
  }

  /** Cancel the in-flight request for a session. Returns true if one was found. */
  cancel(sessionKey: string): boolean {
    const controller = this.controllers.get(sessionKey);
    if (!controller) return false;
    controller.abort();
    this.controllers.delete(sessionKey);
    return true;
  }

  /** Remove a controller (called when a request completes normally). */
  remove(sessionKey: string): void {
    this.controllers.delete(sessionKey);
  }

  get size(): number {
    return this.controllers.size;
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

function chatCompletionResponse(
  content: string,
  model: string,
  usage: Record<string, number>,
  toolsUsed?: string[],
): ChatCompletionResponse {
  const promptTokens = usage["prompt_tokens"] ?? 0;
  const completionTokens = usage["completion_tokens"] ?? 0;
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
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: usage["total_tokens"] ?? promptTokens + completionTokens,
    },
    // tarantul extension: tools used in this turn
    ...(toolsUsed && toolsUsed.length > 0 ? { tools_used: toolsUsed } : {}),
  } as ChatCompletionResponse;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function extractText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join(" ");
}

function resolveSessionKey(body: { session_id?: string }): string {
  return body.session_id ? `api:${body.session_id}` : DEFAULT_SESSION_KEY;
}

function extractPathParam(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  // Remove trailing slashes and further path segments
  const segment = rest.split("/")[0];
  return segment && segment.length > 0 ? decodeURIComponent(segment) : null;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function checkAuth(req: Request, opts: ApiServerOpts): Response | null {
  if (!opts.apiKey) return null;
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!safeStringEqual(token, opts.apiKey)) {
    return errorResponse(401, "Invalid API key", "authentication_error");
  }
  return null;
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
  mutexRegistry: MutexRegistry,
  abortRegistry: AbortRegistry,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  let body: ChatCompletionRequest;
  try {
    body = (await req.json()) as ChatCompletionRequest;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(400, "messages must be a non-empty array");
  }

  if (body.model && body.model !== opts.modelName) {
    return errorResponse(400, `Only configured model '${opts.modelName}' is available`);
  }

  const userMessages = body.messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) {
    return errorResponse(400, "At least one user message is required");
  }
  const lastUser = userMessages[userMessages.length - 1]!;
  const userContent = extractText(lastUser);
  if (!userContent.trim()) {
    return errorResponse(400, "User message content must not be empty");
  }

  if (body.session_id !== undefined && !isValidSessionId(body.session_id)) {
    return errorResponse(
      400,
      `session_id must be 1-${SESSION_ID_MAX_LENGTH} characters of letters, digits, '.', '_', ':', or '-'`,
    );
  }
  const sessionKey = resolveSessionKey(body);

  // -------------------------------------------------------------------------
  // Streaming path (SSE)
  // -------------------------------------------------------------------------
  if (body.stream) {
    return handleStreamingChat(
      userContent,
      sessionKey,
      opts,
      runner,
      sessions,
      tools,
      runSpec,
      mutexRegistry,
      abortRegistry,
      req,
    );
  }

  // -------------------------------------------------------------------------
  // Non-streaming path
  // -------------------------------------------------------------------------
  const mutex = mutexRegistry.get(sessionKey);
  const release = await mutex.acquire();
  const controller = abortRegistry.create(sessionKey);

  logger.info({ sessionKey, content: userContent.slice(0, 80) }, "api request");

  const runOnce = () =>
    runTurn(
      userContent, sessionKey, runner, sessions, tools, runSpec, opts.modelName, opts.getSystemPrompt,
      controller.signal,
    );
  const turn = opts.wrapTurn ? opts.wrapTurn(sessionKey, runOnce) : runOnce();
  turn.catch(() => { /* surfaced below */ })
    .finally(() => {
      abortRegistry.remove(sessionKey);
      release();
    });

  try {
    const { text: responseText, usage, toolsUsed } = await withTimeout(turn, opts.timeoutSecs * 1000);
    return jsonResponse(chatCompletionResponse(responseText, opts.modelName, usage, toolsUsed));
  } catch (err) {
    if (err instanceof TimeoutError) {
      return errorResponse(504, `Request timed out after ${opts.timeoutSecs}s`, "timeout_error");
    }
    logger.error({ err, sessionKey }, "api error");
    return errorResponse(500, "Internal server error", "server_error");
  }
}

// ---------------------------------------------------------------------------
// Streaming chat handler (SSE)
// ---------------------------------------------------------------------------

async function handleStreamingChat(
  userContent: string,
  sessionKey: string,
  opts: ApiServerOpts,
  runner: AgentRunner,
  sessions: SessionManager,
  tools: ToolRegistry,
  runSpec: Omit<AgentRunSpec, "initialMessages">,
  mutexRegistry: MutexRegistry,
  abortRegistry: AbortRegistry,
  req: Request,
): Promise<Response> {
  const mutex = mutexRegistry.get(sessionKey);
  const release = await mutex.acquire();
  const controller = abortRegistry.create(sessionKey);

  const chunkId = `chatcmpl-${randomBytes(6).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);

  logger.info({ sessionKey, content: userContent.slice(0, 80), stream: true }, "api request (stream)");

  let streamHook: ServerStreamHook | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      streamHook = new ServerStreamHook(ctrl, chunkId, opts.modelName, created);

      // Run the turn in the background; the stream stays open until done.
      const runTurnAsync = async () => {
        try {
          const session = sessions.getOrCreate(sessionKey);
          const history = session.getHistory(0);

          const systemPrompt = opts.getSystemPrompt?.(sessionKey) ?? "You are a helpful AI assistant.";
          const messages = buildMessages({
            history,
            currentMessage: userContent,
            systemPrompt,
            channel: API_CHANNEL,
            chatId: API_CHAT_ID,
          });

          const result = await runner.run({
            ...runSpec,
            initialMessages: messages,
            hook: streamHook!,
            signal: controller.signal,
          });

          let text = result.finalContent?.trim() ?? "";

          // If no streaming happened and there's content, emit it now
          if (!streamHook!.didStream && text) {
            // The hook will emit it as a single chunk
            await streamHook!.onStream(
              { iteration: 0, messages: [] },
              text,
            );
          }

          // Persist full turn (fix: include all runner messages, not just text)
          const finalText = text || EMPTY_FINAL_RESPONSE_MESSAGE;
          const now = new Date().toISOString();
          session.addMessage("user", userContent);
          const newMsgs = result.messages.slice(messages.length);
          if (newMsgs.length > 0) {
            session.addMessages(newMsgs as Record<string, unknown>[], now);
          } else {
            session.addMessage("assistant", finalText);
          }
          recordTurnUsage(session, result.usage, opts.modelName);
          await sessions.save(session);

          // Close the SSE stream
          const finishReason = result.stopReason === "cancelled" ? "stop" : "stop";
          streamHook!.close(finishReason);
        } catch (err) {
          logger.error({ err, sessionKey }, "streaming turn error");
          streamHook!.closeWithError(
            err instanceof Error ? err.message : "Internal server error",
          );
        } finally {
          abortRegistry.remove(sessionKey);
          release();
        }
      };

      void runTurnAsync();
    },
    cancel() {
      // Client disconnected — abort the in-flight turn (verification concern: (B) fallback).
      controller.abort();
      abortRegistry.remove(sessionKey);
      if (streamHook && !streamHook.isClosed) {
        streamHook.close("stop");
      }
      release();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------
// runTurn — full-turn execution with proper persistence
// ---------------------------------------------------------------------------

async function runTurn(
  userContent: string,
  sessionKey: string,
  runner: AgentRunner,
  sessions: SessionManager,
  tools: ToolRegistry,
  runSpec: Omit<AgentRunSpec, "initialMessages">,
  modelName: string,
  getSystemPrompt: ((key: string) => string) | null | undefined,
  signal?: AbortSignal | null,
): Promise<{ text: string; usage: Record<string, number>; toolsUsed: string[] }> {
  const session = sessions.getOrCreate(sessionKey);
  const history = session.getHistory(0);

  const systemPrompt = getSystemPrompt?.(sessionKey) ?? "You are a helpful AI assistant.";
  const messages = buildMessages({
    history,
    currentMessage: userContent,
    systemPrompt,
    channel: API_CHANNEL,
    chatId: API_CHAT_ID,
  });

  const result = await runner.run({
    ...runSpec,
    initialMessages: messages,
    ...(signal ? { signal } : {}),
  });
  let text = result.finalContent?.trim() ?? "";
  const usage: Record<string, number> = { ...result.usage };
  const toolsUsed = result.toolsUsed.slice();

  // Retry once on empty
  if (!text) {
    logger.warn({ sessionKey }, "empty response, retrying once");
    const retry = await runner.run({
      ...runSpec,
      initialMessages: messages,
      ...(signal ? { signal } : {}),
    });
    text = retry.finalContent?.trim() ?? "";
    for (const [k, v] of Object.entries(retry.usage)) {
      usage[k] = (usage[k] ?? 0) + v;
    }
    toolsUsed.push(...retry.toolsUsed);
  }

  // --- Full turn persistence (FIX: port CLI pattern) ---
  // Persist the user message + ALL runner messages (assistant, tool_calls,
  // tool results) so the model sees its own tool results on the next turn.
  const finalText = text || EMPTY_FINAL_RESPONSE_MESSAGE;
  const now = new Date().toISOString();
  session.addMessage("user", userContent);

  const newMsgs = result.messages.slice(messages.length);
  if (newMsgs.length > 0) {
    // Runner produced structured messages (assistant + tool interactions)
    session.addMessages(newMsgs as Record<string, unknown>[], now);
  } else {
    // Fallback: no structured messages (shouldn't happen, but be safe)
    session.addMessage("assistant", finalText);
  }

  recordTurnUsage(session, usage, modelName);
  await sessions.save(session);

  return { text: finalText, usage, toolsUsed };
}

// ---------------------------------------------------------------------------
// Session management handlers
// ---------------------------------------------------------------------------

async function handleListSessions(
  req: Request,
  opts: ApiServerOpts,
  sessions: SessionManager,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  const list = sessions.listSessions();
  return jsonResponse({
    sessions: list.map((s) => ({
      key: s.key,
      title: s.title ?? null,
      created_at: s.createdAt ?? null,
      updated_at: s.updatedAt ?? null,
    })),
  });
}

async function handleCreateSession(
  req: Request,
  opts: ApiServerOpts,
  sessions: SessionManager,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  let body: { session_id?: string } = {};
  try {
    body = (await req.json()) as { session_id?: string };
  } catch {
    // No body = auto-generate id
  }

  const sessionId = body.session_id ?? `api_${Date.now()}`;
  if (!isValidSessionId(sessionId)) {
    return errorResponse(400, "Invalid session_id format");
  }

  const key = `api:${sessionId}`;
  sessions.getOrCreate(key); // creates if absent
  await sessions.save(sessions.getOrCreate(key));

  return jsonResponse({ session_id: sessionId, key }, 201);
}

async function handleDeleteSession(
  req: Request,
  opts: ApiServerOpts,
  sessions: SessionManager,
  sessionId: string,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  const key = `api:${sessionId}`;
  const deleted = sessions.deleteSession(key);
  if (!deleted) {
    return errorResponse(404, `Session '${sessionId}' not found`);
  }
  return jsonResponse({ deleted: true, session_id: sessionId });
}

async function handleClearSession(
  req: Request,
  opts: ApiServerOpts,
  sessions: SessionManager,
  sessionId: string,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  const key = `api:${sessionId}`;
  const session = sessions.getOrCreate(key);
  session.clear();
  await sessions.save(session);
  sessions.invalidate(key);

  return jsonResponse({ cleared: true, session_id: sessionId });
}

// ---------------------------------------------------------------------------
// Cancel handler
// ---------------------------------------------------------------------------

async function handleCancel(
  req: Request,
  opts: ApiServerOpts,
  abortRegistry: AbortRegistry,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  let body: CancelRequest;
  try {
    body = (await req.json()) as CancelRequest;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!body.session_id) {
    return errorResponse(400, "session_id is required");
  }

  const key = resolveSessionKey(body);
  const cancelled = abortRegistry.cancel(key);

  return jsonResponse({
    cancelled,
    session_id: body.session_id,
    message: cancelled ? "Request cancelled." : "No active request for this session.",
  });
}

// ---------------------------------------------------------------------------
// Settings handlers
// ---------------------------------------------------------------------------

async function handleGetSettings(
  req: Request,
  opts: ApiServerOpts,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  if (!opts.settings) {
    return errorResponse(501, "Settings not available — server started without SettingsController");
  }

  return jsonResponse(opts.settings.overview());
}

async function handlePatchSettings(
  req: Request,
  opts: ApiServerOpts,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  if (!opts.settings) {
    return errorResponse(501, "Settings not available");
  }

  let body: SettingsPatchRequest;
  try {
    body = (await req.json()) as SettingsPatchRequest;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!body.path || body.value === undefined) {
    return errorResponse(400, "Both 'path' and 'value' are required");
  }

  const result = opts.settings.setValue(body.path, body.value);
  if (!result.ok) {
    return errorResponse(400, result.error ?? "Unknown error");
  }

  return jsonResponse({ ok: true, path: body.path });
}

async function handleGetProviders(
  req: Request,
  opts: ApiServerOpts,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  if (!opts.settings) {
    return errorResponse(501, "Settings not available");
  }

  const providers = opts.settings.configuredProviders();
  const withModels = providers.map((p) => ({
    ...p,
    models: opts.settings!.providerModels(p.name),
  }));

  return jsonResponse({ providers: withModels });
}

async function handleSetModel(
  req: Request,
  opts: ApiServerOpts,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  if (!opts.settings) {
    return errorResponse(501, "Settings not available");
  }

  let body: SetModelRequest;
  try {
    body = (await req.json()) as SetModelRequest;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (!body.provider || !body.model) {
    return errorResponse(400, "'provider' and 'model' are required");
  }

  const result = opts.settings.setActiveModel(body.provider, body.model);
  if (!result.ok) {
    return errorResponse(400, result.error ?? "Unknown error");
  }

  // Rebuild provider/runner to pick up the new model.
  if (opts.onProviderRebuild) opts.onProviderRebuild();

  return jsonResponse({
    ok: true,
    model: `${body.provider}/${body.model}`,
    persisted: Boolean(body.persist),
  });
}

// ---------------------------------------------------------------------------
// Status / Usage / Help handlers
// ---------------------------------------------------------------------------

async function handleStatus(
  req: Request,
  opts: ApiServerOpts,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  const uptime = opts.startedAt
    ? Math.floor(Date.now() / 1000 - opts.startedAt)
    : 0;
  const uptimeStr =
    uptime < 60
      ? `${uptime}s`
      : uptime < 3600
        ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
        : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  return jsonResponse({
    version: VERSION,
    model: opts.modelName,
    uptime: uptimeStr,
    uptime_seconds: uptime,
  });
}

async function handleUsage(
  req: Request,
  opts: ApiServerOpts,
  sessions: SessionManager,
  sessionId?: string | null,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  const key = sessionId ? `api:${sessionId}` : DEFAULT_SESSION_KEY;
  const session = sessions.getOrCreate(key);
  const usage = getSessionUsage(session);

  return jsonResponse({
    session_key: key,
    usage: usage ?? null,
    formatted: formatUsageSummary(usage),
  });
}

async function handleHelp(
  req: Request,
  opts: ApiServerOpts,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  return jsonResponse({
    endpoints: [
      { method: "POST", path: "/v1/chat/completions", description: "Chat with the agent (supports stream=true)" },
      { method: "GET", path: "/v1/models", description: "List available models" },
      { method: "GET", path: "/v1/sessions", description: "List all sessions" },
      { method: "POST", path: "/v1/sessions", description: "Create a new session" },
      { method: "DELETE", path: "/v1/sessions/:id", description: "Delete a session" },
      { method: "POST", path: "/v1/sessions/:id/clear", description: "Clear session history" },
      { method: "POST", path: "/v1/cancel", description: "Cancel an in-flight request" },
      { method: "GET", path: "/v1/settings", description: "View current settings" },
      { method: "PATCH", path: "/v1/settings", description: "Update a settings value" },
      { method: "GET", path: "/v1/settings/providers", description: "List providers with models" },
      { method: "POST", path: "/v1/settings/model", description: "Switch active model" },
      { method: "GET", path: "/v1/status", description: "Server status" },
      { method: "GET", path: "/v1/usage", description: "Default session usage" },
      { method: "GET", path: "/v1/usage/:session_id", description: "Session usage" },
      { method: "GET", path: "/v1/permissions/pending", description: "List pending tool permissions" },
      { method: "POST", path: "/v1/permissions/:id/resolve", description: "Allow or deny a tool permission" },
      { method: "GET", path: "/v1/help", description: "This endpoint" },
      { method: "GET", path: "/health", description: "Health check" },
    ],
  });
}

// ---------------------------------------------------------------------------
// Permission handlers
// ---------------------------------------------------------------------------

async function handleListPermissions(
  req: Request,
  opts: ApiServerOpts,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  if (!opts.permissions) {
    return jsonResponse({ pending: [] });
  }
  return jsonResponse({ pending: opts.permissions.listPending() });
}

async function handleResolvePermission(
  req: Request,
  opts: ApiServerOpts,
  permissionId: string,
): Promise<Response> {
  const authErr = checkAuth(req, opts);
  if (authErr) return authErr;

  if (!opts.permissions) {
    return errorResponse(404, "Permission not found (permissions not enabled)");
  }

  let body: { allow: boolean };
  try {
    body = (await req.json()) as { allow: boolean };
  } catch {
    return errorResponse(400, "Invalid JSON body — expected { \"allow\": true|false }");
  }

  if (typeof body.allow !== "boolean") {
    return errorResponse(400, "'allow' must be a boolean");
  }

  const resolved = opts.permissions.resolve(permissionId, body.allow);
  if (!resolved) {
    return errorResponse(404, `Permission '${permissionId}' not found or already resolved`);
  }

  return jsonResponse({ resolved: true, id: permissionId, allowed: body.allow });
}

// ---------------------------------------------------------------------------
// Models / Health
// ---------------------------------------------------------------------------

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
  private readonly _mutexRegistry = new MutexRegistry(MAX_TRACKED_SESSIONS);
  private readonly _abortRegistry = new AbortRegistry();

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
    const mutexRegistry = this._mutexRegistry;
    const abortRegistry = this._abortRegistry;

    this._server = Bun.serve({
      hostname: host,
      port,
      fetch: async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method.toUpperCase();

        // ----- Chat completions -----
        if (method === "POST" && path === "/v1/chat/completions") {
          return handleChatCompletions(req, opts, runner, sessions, tools, runSpec, mutexRegistry, abortRegistry);
        }

        // ----- Models -----
        if (method === "GET" && path === "/v1/models") {
          return handleModels(opts);
        }

        // ----- Sessions -----
        if (method === "GET" && path === "/v1/sessions") {
          return handleListSessions(req, opts, sessions);
        }
        if (method === "POST" && path === "/v1/sessions") {
          return handleCreateSession(req, opts, sessions);
        }
        // DELETE /v1/sessions/:id
        if (method === "DELETE" && path.startsWith("/v1/sessions/")) {
          const sessionId = extractPathParam(path, "/v1/sessions/");
          if (!sessionId) return errorResponse(400, "Missing session id");
          return handleDeleteSession(req, opts, sessions, sessionId);
        }
        // POST /v1/sessions/:id/clear
        if (method === "POST" && path.match(/^\/v1\/sessions\/[^/]+\/clear$/)) {
          const sessionId = extractPathParam(path, "/v1/sessions/");
          if (!sessionId) return errorResponse(400, "Missing session id");
          return handleClearSession(req, opts, sessions, sessionId);
        }

        // ----- Cancel -----
        if (method === "POST" && path === "/v1/cancel") {
          return handleCancel(req, opts, abortRegistry);
        }

        // ----- Settings -----
        if (method === "GET" && path === "/v1/settings") {
          return handleGetSettings(req, opts);
        }
        if (method === "PATCH" && path === "/v1/settings") {
          return handlePatchSettings(req, opts);
        }
        if (method === "GET" && path === "/v1/settings/providers") {
          return handleGetProviders(req, opts);
        }
        if (method === "POST" && path === "/v1/settings/model") {
          return handleSetModel(req, opts);
        }

        // ----- Status / Usage / Help -----
        if (method === "GET" && path === "/v1/status") {
          return handleStatus(req, opts);
        }
        if (method === "GET" && path === "/v1/help") {
          return handleHelp(req, opts);
        }
        if (method === "GET" && path === "/v1/usage") {
          return handleUsage(req, opts, sessions);
        }
        if (method === "GET" && path.startsWith("/v1/usage/")) {
          const sessionId = extractPathParam(path, "/v1/usage/");
          return handleUsage(req, opts, sessions, sessionId);
        }

        // ----- Permissions -----
        if (method === "GET" && path === "/v1/permissions/pending") {
          return handleListPermissions(req, opts);
        }
        if (method === "POST" && path.match(/^\/v1\/permissions\/[^/]+\/resolve$/)) {
          const permId = extractPathParam(path, "/v1/permissions/");
          if (!permId) return errorResponse(400, "Missing permission id");
          return handleResolvePermission(req, opts, permId);
        }

        // ----- Health -----
        if (method === "GET" && (path === "/health" || path === "/")) {
          return handleHealth();
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
