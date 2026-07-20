import { EventEmitter } from "node:events";

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

/** User's answer to a permission prompt. Emitted at the main.ts call site. */
export type PermDecision = "yes" | "no" | "always";

/** One selectable row in a {@link SelectorSpec} overlay. */
export interface SelectOption {
  label: string;
  /** Dim inline detail, e.g. a relative timestamp. */
  detail?: string;
}

/**
 * Declarative spec for the generic arrow-key selector overlay, reused by the
 * permission prompt, the summarize-on-leave confirm, and the /sessions picker.
 */
export interface SelectorSpec {
  /** Header line (accent-colored). */
  title: string;
  /** Optional dim context lines under the header. */
  body?: string[];
  options: readonly SelectOption[];
  /** What Esc resolves to: an option index, or null = cancel. */
  escResolvesTo: number | null;
  /** Border/header accent: "warn" = orange (permission), "info" = purple. */
  accent: "warn" | "info";
  /** Footer hint override. */
  hint?: string;
}

/** One replayed transcript line when resuming a session. */
export interface ReplayEntry {
  role: "user" | "assistant";
  text: string;
}

/** Events the turn runner pushes to the UI via {@link UiBridge}. */
export type UiEvent =
  | { t: "assistant-delta"; text: string }
  | { t: "assistant-end"; model: string }
  | { t: "tool-start"; id: string; label: string }
  | { t: "tool-end"; id: string; ok: boolean; detail: string }
  | { t: "notice"; text: string; tone: "info" | "error" }
  | { t: "busy"; value: boolean; label?: string }
  | { t: "select"; spec: SelectorSpec; resolve: (index: number | null) => void }
  | { t: "replay"; entries: ReplayEntry[] }
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
