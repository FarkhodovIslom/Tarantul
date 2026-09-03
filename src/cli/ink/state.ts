import type { RunningTool, TranscriptItem, UiEvent } from "./types.js";

/**
 * Split-state pattern for the fullscreen TUI.
 *
 * Three independent slices keep React re-renders narrow:
 * - {@link TranscriptSlice}: finalized items — only changes on assistant/tool/notice events.
 * - {@link LiveSlice}: live streaming content + busy state — changes on every delta.
 * - {@link UiSlice}: input box, selector, autocomplete, history — changes on every keystroke.
 *
 * Keeping the slices separate means typing in the input box does not re-render the
 * transcript, and an incoming assistant delta does not invalidate the input cursor.
 */

export interface TranscriptSlice {
  /** Monotonic id used for React keys. */
  nextId: number;
  /** Finalized transcript items, in chronological order. */
  items: TranscriptItem[];
  /**
   * Bumped on `clear`. Used by the Banner to decide whether to re-show itself
   * after the user runs `/new` or `/sessions` (a fresh generation hides the banner).
   */
  generation: number;
}

export interface LiveSlice {
  /** Accumulated assistant text currently being streamed. Empty when idle. */
  assistant: string;
  /** Tools currently executing (shown in the live region). */
  tools: RunningTool[];
  /** True while the agent is mid-turn. */
  busy: boolean;
  /** Spinner label ("Thinking…" / "Working…" / "Writing…" / etc.). */
  busyLabel: string | null;
}

export interface UiSlice {
  /** Text in the input box. */
  input: string;
  /** Cursor position inside `input` (0 = before first char). */
  cursor: number;
  /** Current index into `localHistory` for ↑/↓ navigation. May equal length = "past the end". */
  histIdx: number;
  /** Highlighted option index in the open selector overlay (0-based). */
  selIndex: number;
  /** Highlighted option index in the slash-command autocomplete dropdown (0-based). */
  acIndex: number;
  /**
   * If non-null, suppress slash-command suggestions until the input text differs
   * from this value. Captured when the user hits Esc on the autocomplete list.
   */
  dismissedFor: string | null;
}

export interface AppState {
  transcript: TranscriptSlice;
  live: LiveSlice;
  ui: UiSlice;
}

export const initialLiveSlice: LiveSlice = {
  assistant: "",
  tools: [],
  busy: false,
  busyLabel: null,
};

export const initialUiSlice: UiSlice = {
  input: "",
  cursor: 0,
  histIdx: 0,
  selIndex: 0,
  acIndex: 0,
  dismissedFor: null,
};

export function initialTranscriptSlice(
  initialNextId: number,
  initial: TranscriptItem[],
): TranscriptSlice {
  return { nextId: initialNextId, items: initial, generation: 0 };
}

// ---------------------------------------------------------------------------
// Transcript + Live reducers
// ---------------------------------------------------------------------------

function timeStamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Push a finalized item into the transcript, advancing nextId. */
function push(transcript: TranscriptSlice, item: TranscriptItem): TranscriptSlice {
  return {
    ...transcript,
    nextId: transcript.nextId + 1,
    items: [...transcript.items, item],
  };
}

/** An assistant item without a model footer (mid-turn flush / replayed history). */
function bareAssistant(id: number, text: string): TranscriptItem {
  return { id, kind: "assistant", text, model: "", time: "" };
}

/**
 * Apply one `UiEvent` to the transcript + live slices.
 *
 * Returns updated slices (or the originals if the event does not affect them).
 * The caller composes these into the surrounding `AppState`.
 */
export function applyUiEvent(
  transcript: TranscriptSlice,
  live: LiveSlice,
  event: UiEvent,
): { transcript: TranscriptSlice; live: LiveSlice } {
  switch (event.t) {
    case "assistant-delta":
      if (!event.text) return { transcript, live };
      return { transcript, live: { ...live, assistant: live.assistant + event.text } };

    case "assistant-end": {
      if (!live.assistant) return { transcript, live };
      return {
        transcript: push(transcript, {
          id: transcript.nextId,
          kind: "assistant",
          text: live.assistant,
          model: event.model,
          time: timeStamp(),
        }),
        live: { ...live, assistant: "" },
      };
    }

    case "tool-start": {
      // Flush any pending assistant text first so tool lines stay in order.
      let nextTranscript = transcript;
      let nextLive = live;
      if (live.assistant) {
        nextTranscript = push(transcript, bareAssistant(transcript.nextId, live.assistant));
        nextLive = { ...live, assistant: "" };
      }
      return {
        transcript: nextTranscript,
        live: {
          ...nextLive,
          tools: [...nextLive.tools, { id: event.id, label: event.label }],
        },
      };
    }

    case "tool-end": {
      const running = live.tools.find((t) => t.id === event.id);
      return {
        transcript: push(transcript, {
          id: transcript.nextId,
          kind: "tool",
          label: running?.label ?? "tool",
          ok: event.ok,
          detail: event.detail,
        }),
        live: { ...live, tools: live.tools.filter((t) => t.id !== event.id) },
      };
    }

    case "notice":
      return {
        transcript: push(transcript, {
          id: transcript.nextId,
          kind: "notice",
          text: event.text,
          tone: event.tone,
        }),
        live,
      };

    case "busy":
      return {
        transcript,
        live: {
          ...live,
          busy: event.value,
          busyLabel: event.value ? (event.label ?? null) : null,
        },
      };

    case "select":
      // The selector overlay is set imperatively (App.tsx) because its
      // `resolve` callback must come from the imperative side, not from React
      // state — this reducer has no business touching it.
      return { transcript, live };

    case "replay": {
      // Resume-context seed: append user/assistant entries as finalized items
      // with empty model/time (these lines pre-date the current session and
      // therefore carry no footer metadata).
      let next = transcript;
      for (const entry of event.entries) {
        const item: TranscriptItem =
          entry.role === "user"
            ? { id: next.nextId, kind: "user", text: entry.text }
            : { id: next.nextId, kind: "assistant", text: entry.text, model: "", time: "" };
        next = { ...next, nextId: next.nextId + 1, items: [...next.items, item] };
      }
      return { transcript: next, live };
    }

    case "clear":
      return {
        transcript: { ...transcript, items: [], generation: transcript.generation + 1 },
        live: { ...live, assistant: "", tools: [] },
      };

    default:
      return { transcript, live };
  }
}

/**
 * Action union for the combined transcript+live reducer.
 * - `event` applies a `UiEvent` (assistant stream, tool lifecycle, busy, notice, clear).
 * - `submit-user` pushes a finalized user line into the transcript.
 */
export type SliceAction = { type: "event"; e: UiEvent } | { type: "submit-user"; text: string };

/**
 * Combined reducer for the transcript + live slices.
 *
 * Replaces the previous split `transcriptReduce` + `liveReduce` pair, where
 * events affecting BOTH slices (e.g. `assistant-end`, `tool-start`, `tool-end`)
 * were applied independently to fresh-empty counterparts of the other slice —
 * causing streamed assistant text to vanish and tool labels to fall back to
 * the literal "tool". By holding both slices together, every event is applied
 * against the real state in a single pass.
 *
 * UiSlice lives in its own `useState` and is untouched here.
 */
export function appSliceReduce(
  state: { transcript: TranscriptSlice; live: LiveSlice },
  action: SliceAction,
): { transcript: TranscriptSlice; live: LiveSlice } {
  if (action.type === "submit-user") {
    return {
      transcript: {
        ...state.transcript,
        nextId: state.transcript.nextId + 1,
        items: [
          ...state.transcript.items,
          { id: state.transcript.nextId, kind: "user", text: action.text },
        ],
      },
      live: state.live,
    };
  }
  return applyUiEvent(state.transcript, state.live, action.e);
}

// ---------------------------------------------------------------------------
// Pure helpers for UiSlice
// ---------------------------------------------------------------------------

/** Insert a character at the cursor, return new slice + new cursor. */
export function insertChar(ui: UiSlice, ch: string): UiSlice {
  return {
    ...ui,
    input: ui.input.slice(0, ui.cursor) + ch + ui.input.slice(ui.cursor),
    cursor: ui.cursor + ch.length,
    acIndex: 0,
  };
}

/** Delete the character immediately before the cursor (backspace / delete). */
export function deleteBeforeCursor(ui: UiSlice): UiSlice {
  if (ui.cursor <= 0) return ui;
  return {
    ...ui,
    input: ui.input.slice(0, ui.cursor - 1) + ui.input.slice(ui.cursor),
    cursor: ui.cursor - 1,
    acIndex: 0,
  };
}

/** Move the cursor left, clamped at 0. */
export function moveCursorLeft(ui: UiSlice): UiSlice {
  return { ...ui, cursor: Math.max(0, ui.cursor - 1) };
}

/** Move the cursor right, clamped at `input.length`. */
export function moveCursorRight(ui: UiSlice): UiSlice {
  return { ...ui, cursor: Math.min(ui.input.length, ui.cursor + 1) };
}

/** Reset input box to empty (after submit, after `/stop`, etc). */
export function resetInput(ui: UiSlice): UiSlice {
  return { ...ui, input: "", cursor: 0, dismissedFor: null };
}

/**
 * History navigation — pure helpers used from the input box's ↑/↓ handlers.
 *
 * `histIdx` semantics: an index in `[0, entries.length]`. `entries.length`
 * means "past the end" (i.e. the live input is its own thing, not a recalled
 * line). Returning `null` means the cursor is already at the boundary and the
 * caller should leave the input alone.
 *
 * Initializing `ui.histIdx` to `entries.length` is what makes the first ↑
 * load the most recent entry instead of the oldest (was previously broken:
 * the UI slice initialized to 0, so the first ↑ jumped to entries[0]).
 */
export function historyPrev(ui: UiSlice, entries: readonly string[]): UiSlice | null {
  if (ui.histIdx <= 0) return null;
  const idx = ui.histIdx - 1;
  const v = entries[idx] ?? "";
  return { ...ui, histIdx: idx, input: v, cursor: v.length, acIndex: 0 };
}

export function historyNext(ui: UiSlice, entries: readonly string[]): UiSlice | null {
  if (ui.histIdx >= entries.length) return null;
  const idx = ui.histIdx + 1;
  const v = entries[idx] ?? "";
  return { ...ui, histIdx: idx, input: v, cursor: v.length, acIndex: 0 };
}
