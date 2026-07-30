import { AgentHook } from "../agent/hook.js";
import type { AgentHookContext, ToolEvent } from "../agent/hook.js";
import type { ToolCallRequest } from "../providers/base.js";

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function toolCallLabel(name: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  const hint = keys.slice(0, 2).join(", ");
  return hint ? `${name}(${hint})` : name;
}

// ---------------------------------------------------------------------------
// Streaming chunk types (OpenAI-compatible)
// ---------------------------------------------------------------------------

interface StreamChoice {
  index: number;
  delta: {
    role?: string;
    content?: string;
  };
  finish_reason: string | null;
}

interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: StreamChoice[];
}

// ---------------------------------------------------------------------------
// ServerStreamHook — SSE streaming hook for the API server
// ---------------------------------------------------------------------------

/**
 * Streaming hook that writes OpenAI-compatible SSE chunks to a
 * ReadableStream controller. One instance per streaming request.
 *
 * Lifecycle:
 *   1. Agent loop calls onStream() with text deltas → SSE content chunks
 *   2. Tool calls emit optional metadata events (tool-start/tool-end)
 *   3. On completion or error, close() writes `data: [DONE]` and closes the stream
 *
 * Error safety: close() is idempotent and always runs in finally blocks
 * so the client stream is never left in a pending state (verification concern #4).
 */
export class ServerStreamHook extends AgentHook {
  private _closed = false;
  private _toolSeq = 0;
  /** True once any assistant delta has been emitted. */
  didStream = false;
  /** True when the first delta in a new assistant turn needs a role field. */
  private _needsRole = true;

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly chunkId: string,
    private readonly model: string,
    private readonly created: number,
    /** Whether to emit tool-start/tool-end metadata events in the SSE stream. */
    private readonly emitToolEvents: boolean = true,
  ) {
    super();
  }

  override wantsStreaming(): boolean {
    return true;
  }

  // -------------------------------------------------------------------------
  // Content streaming
  // -------------------------------------------------------------------------

  override async onStream(_ctx: AgentHookContext, delta: string): Promise<void> {
    if (this._closed || !delta) return;
    this.didStream = true;

    const chunk: ChatCompletionChunk = {
      id: this.chunkId,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: this._needsRole
            ? { role: "assistant", content: delta }
            : { content: delta },
          finish_reason: null,
        },
      ],
    };
    this._needsRole = false;
    this._enqueue(sseChunk(chunk));
  }

  override async onStreamEnd(_ctx: AgentHookContext, opts: { resuming: boolean }): Promise<void> {
    // When the model pauses to run tools (resuming=true), reset so the next
    // assistant turn's first delta carries the role field again.
    if (opts.resuming) {
      this._needsRole = true;
    }
  }

  // -------------------------------------------------------------------------
  // Tool events (optional metadata in the SSE stream)
  // -------------------------------------------------------------------------

  override async onToolStart(_ctx: AgentHookContext, tc: ToolCallRequest): Promise<void> {
    if (!this.emitToolEvents || this._closed) return;
    this._toolSeq++;
    const event = `event: tool_start\ndata: ${JSON.stringify({
      id: `t${this._toolSeq}`,
      tool: tc.name,
      label: toolCallLabel(tc.name, tc.arguments),
    })}\n\n`;
    this._enqueue(event);
  }

  override async onToolEnd(
    _ctx: AgentHookContext,
    tc: ToolCallRequest,
    event: ToolEvent,
  ): Promise<void> {
    if (!this.emitToolEvents || this._closed) return;
    const sseEvent = `event: tool_end\ndata: ${JSON.stringify({
      id: `t${this._toolSeq}`,
      tool: tc.name,
      status: event.status,
      detail: event.detail ?? "",
    })}\n\n`;
    this._enqueue(sseEvent);
  }

  // -------------------------------------------------------------------------
  // Finalization
  // -------------------------------------------------------------------------

  /**
   * Emit the final stop chunk and `data: [DONE]`, then close the stream.
   * Idempotent — safe to call from both the happy path and error handlers.
   */
  close(finishReason: string = "stop"): void {
    if (this._closed) return;
    this._closed = true;

    try {
      // Final chunk with finish_reason
      const finalChunk: ChatCompletionChunk = {
        id: this.chunkId,
        object: "chat.completion.chunk",
        created: this.created,
        model: this.model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      };
      this._enqueue(sseChunk(finalChunk));
      this._enqueue("data: [DONE]\n\n");
      this.controller.close();
    } catch {
      // Controller may already be closed (client disconnected) — ignore.
      try { this.controller.close(); } catch { /* already closed */ }
    }
  }

  /**
   * Emit an error event and close the stream. The error is sent as a
   * structured SSE event so well-behaved clients can display it.
   */
  closeWithError(message: string): void {
    if (this._closed) return;
    this._closed = true;

    try {
      const errorEvent = `event: error\ndata: ${JSON.stringify({ message })}\n\n`;
      this._enqueue(errorEvent);
      this._enqueue("data: [DONE]\n\n");
      this.controller.close();
    } catch {
      try { this.controller.close(); } catch { /* already closed */ }
    }
  }

  get isClosed(): boolean {
    return this._closed;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _enqueue(text: string): void {
    try {
      this.controller.enqueue(new TextEncoder().encode(text));
    } catch {
      // Stream closed by client disconnect — mark as closed so further
      // writes are no-ops and close() doesn't attempt to write.
      this._closed = true;
    }
  }
}
