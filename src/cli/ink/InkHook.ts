import { AgentHook } from "../../agent/hook.js";
import type { AgentHookContext, ToolEvent } from "../../agent/hook.js";
import type { ToolCallRequest } from "../../providers/base.js";
import { toolCallLabel } from "../render.js";
import type { UiBridge } from "./types.js";

/**
 * Streaming hook that forwards the agent loop's lifecycle to the Ink UI as
 * {@link UiEvent}s. One instance per turn; the App maps the events to state.
 * Each tool call gets a stable id so its running→done transition updates the
 * right live row.
 */
export class InkHook extends AgentHook {
  private toolSeq = 0;
  private readonly idFor = new Map<ToolCallRequest, string>();
  /** True once any assistant text has streamed — lets the caller synthesize a
   *  final block for providers that return content without streaming. */
  didStream = false;

  constructor(
    private readonly bridge: UiBridge,
    private readonly model: string,
  ) {
    super();
  }

  override wantsStreaming(): boolean {
    return true;
  }

  override async onStream(_ctx: AgentHookContext, delta: string): Promise<void> {
    if (delta) {
      this.didStream = true;
      this.bridge.emitEvent({ t: "assistant-delta", text: delta });
    }
  }

  override async onStreamEnd(_ctx: AgentHookContext, opts: { resuming: boolean }): Promise<void> {
    // A "resuming" stream end is an intermediate turn boundary (the model will
    // call tools and continue), so only the final one closes the block.
    if (!opts.resuming) this.bridge.emitEvent({ t: "assistant-end", model: this.model });
  }

  override async onToolStart(_ctx: AgentHookContext, tc: ToolCallRequest): Promise<void> {
    const id = `t${this.toolSeq++}`;
    this.idFor.set(tc, id);
    this.bridge.emitEvent({ t: "tool-start", id, label: toolCallLabel(tc.name, tc.arguments) });
  }

  override async onToolEnd(
    _ctx: AgentHookContext,
    tc: ToolCallRequest,
    event: ToolEvent,
  ): Promise<void> {
    const id = this.idFor.get(tc) ?? `t${this.toolSeq}`;
    this.idFor.delete(tc);
    this.bridge.emitEvent({
      t: "tool-end",
      id,
      ok: event.status === "ok",
      detail: event.detail ?? "",
    });
  }
}
