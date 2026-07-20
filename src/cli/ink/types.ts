import { EventEmitter } from "node:events";
import type { PermissionRequest } from "../../agent/tools/base.js";

/** A finalized transcript entry, rendered once inside Ink's <Static>. */
export type TranscriptItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string; model: string; time: string }
  | { id: number; kind: "tool"; label: string; ok: boolean; detail: string }
  | { id: number; kind: "notice"; text: string; tone: "info" | "error" };

/** A tool call currently executing (shown in the live region). */
export interface RunningTool {
  id: string;
  label: string;
}

/** User's answer to a permission prompt. */
export type PermDecision = "yes" | "no" | "always";

/** Events the turn runner pushes to the UI via {@link UiBridge}. */
export type UiEvent =
  | { t: "assistant-delta"; text: string }
  | { t: "assistant-end"; model: string }
  | { t: "tool-start"; id: string; label: string }
  | { t: "tool-end"; id: string; ok: boolean; detail: string }
  | { t: "notice"; text: string; tone: "info" | "error" }
  | { t: "busy"; value: boolean }
  | { t: "permission"; req: PermissionRequest; resolve: (decision: PermDecision) => void }
  | { t: "clear" };

/**
 * Thin event bus between the imperative agent loop (which emits UiEvents from
 * the streaming hook / permission callback) and the React app (which subscribes
 * and maps them to state). Kept outside React so it survives remounts.
 */
export class UiBridge extends EventEmitter {
  emitEvent(e: UiEvent): void {
    this.emit("ui", e);
  }

  onEvent(listener: (e: UiEvent) => void): () => void {
    this.on("ui", listener);
    return () => this.off("ui", listener);
  }
}
