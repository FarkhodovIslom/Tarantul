import { Box, Static, useApp, useInput } from "ink";
import type React from "react";
import { useEffect, useReducer, useRef, useState } from "react";
import { filterCommands } from "./commands.js";
import { Banner, InputBar, Item, LiveRegion, SelectPrompt, SuggestionList } from "./components.js";
import type {
  ReplayEntry,
  RunningTool,
  SelectorSpec,
  TranscriptItem,
  UiBridge,
  UiEvent,
} from "./types.js";

export interface AppProps {
  bridge: UiBridge;
  version: string;
  model: string;
  statusLeft: string;
  statusRight: string;
  history: string[];
  /** False on remounts after a `/settings` visit — the banner shows once per process. */
  showBanner: boolean;
  /** Transcript seed shown on mount (startup / post-switch resume-context). */
  initialTranscript: ReplayEntry[];
  /** Runs one submitted line (slash command or message). Drives bridge events. */
  onSubmit: (line: string) => Promise<void>;
  /** Persist a line to the shared CLI history file. */
  onHistoryPush: (line: string) => void;
  /** Called when the user types `/settings` — the caller unmounts this app,
   *  runs the settings menu (which needs exclusive raw stdin), then remounts. */
  onSettings: () => void;
  /** Switch-away flow (summarize prompt etc.) awaited before the app exits.
   *  Must always settle; the app exits once it does. */
  onBeforeExit: () => Promise<void>;
}

interface PendingSelector {
  spec: SelectorSpec;
  resolve: (index: number | null) => void;
}

interface State {
  nextId: number;
  items: TranscriptItem[];
  liveAssistant: string;
  liveTools: RunningTool[];
  busy: boolean;
  busyLabel: string | null;
  selector: PendingSelector | null;
}

type Action =
  | { type: "submit-user"; text: string }
  | { type: "set-selector"; value: PendingSelector | null }
  | { type: "event"; e: UiEvent };

function timeStamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function push(state: State, item: TranscriptItem): State {
  return { ...state, nextId: state.nextId + 1, items: [...state.items, item] };
}

/** An assistant item without a model footer (mid-turn flush / replayed history). */
function bareAssistant(id: number, text: string): TranscriptItem {
  return { id, kind: "assistant", text, model: "", time: "" };
}

function initState(props: AppProps): State {
  let nextId = 1;
  const items: TranscriptItem[] = [];
  for (const entry of props.initialTranscript) {
    items.push(
      entry.role === "user"
        ? { id: nextId++, kind: "user", text: entry.text }
        : bareAssistant(nextId++, entry.text),
    );
  }
  return {
    nextId,
    items,
    liveAssistant: "",
    liveTools: [],
    busy: false,
    busyLabel: null,
    selector: null,
  };
}

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "submit-user":
      return push(state, { id: state.nextId, kind: "user", text: action.text });
    case "set-selector":
      return { ...state, selector: action.value };
    case "event":
      break;
  }

  const e = action.e;
  switch (e.t) {
    case "assistant-delta":
      return { ...state, liveAssistant: state.liveAssistant + e.text };
    case "assistant-end": {
      if (!state.liveAssistant) return state;
      return {
        ...push(state, {
          id: state.nextId,
          kind: "assistant",
          text: state.liveAssistant,
          model: e.model,
          time: timeStamp(),
        }),
        liveAssistant: "",
      };
    }
    case "tool-start": {
      // Flush any pending assistant text first so tool lines stay in order.
      let s = state;
      if (s.liveAssistant) {
        s = { ...push(s, bareAssistant(s.nextId, s.liveAssistant)), liveAssistant: "" };
      }
      return { ...s, liveTools: [...s.liveTools, { id: e.id, label: e.label }] };
    }
    case "tool-end": {
      const running = state.liveTools.find((t) => t.id === e.id);
      return {
        ...push(state, {
          id: state.nextId,
          kind: "tool",
          label: running?.label ?? "tool",
          ok: e.ok,
          detail: e.detail,
        }),
        liveTools: state.liveTools.filter((t) => t.id !== e.id),
      };
    }
    case "notice":
      return push(state, { id: state.nextId, kind: "notice", text: e.text, tone: e.tone });
    case "busy":
      return { ...state, busy: e.value, busyLabel: e.value ? (e.label ?? null) : null };
    case "select":
      return { ...state, selector: { spec: e.spec, resolve: e.resolve } };
    case "replay": {
      // Never reset nextId — <Static> has already committed earlier ids.
      let s = state;
      for (const entry of e.entries) {
        s = push(
          s,
          entry.role === "user"
            ? { id: s.nextId, kind: "user", text: entry.text }
            : bareAssistant(s.nextId, entry.text),
        );
      }
      return s;
    }
    case "clear":
      return { ...state, items: [], liveAssistant: "", liveTools: [] };
    default:
      return state;
  }
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reduce, props, initState);

  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [histIdx, setHistIdx] = useState(props.history.length);
  const [localHistory, setLocalHistory] = useState(props.history);
  const [selIndex, setSelIndex] = useState(0);
  const [acIndex, setAcIndex] = useState(0);
  // Input value the autocomplete list was dismissed for (Tab/Esc). Suggestions
  // reappear as soon as the input diverges from it — i.e. on the next edit.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  // Guards the exit flow: first request runs onBeforeExit; a second force-quits.
  const exitingRef = useRef(false);

  useEffect(() => props.bridge.onEvent((e) => dispatch({ type: "event", e })), [props.bridge]);

  // Reset the highlight to the first option whenever a new selector appears.
  useEffect(() => {
    if (state.selector) setSelIndex(0);
  }, [state.selector]);

  // Editing resets the autocomplete highlight to the top match.
  useEffect(() => {
    setAcIndex(0);
  }, [input]);

  const suggestions = input !== dismissedFor ? filterCommands(input) : [];
  const acVisible = !state.selector && !state.busy && suggestions.length > 0;

  const requestExit = (): void => {
    if (exitingRef.current) {
      exit();
      return;
    }
    exitingRef.current = true;
    void props
      .onBeforeExit()
      .catch(() => {})
      .finally(() => exit());
  };

  const resolveSelector = (index: number | null): void => {
    const sel = state.selector;
    if (!sel) return;
    dispatch({ type: "set-selector", value: null });
    sel.resolve(index);
  };

  const submit = (raw: string): void => {
    const line = raw.trim();
    setInput("");
    setCursor(0);
    setDismissedFor(null);
    if (!line) return;
    if (line === "exit" || line === "quit") {
      requestExit();
      return;
    }
    if (line === "/settings" || line === "/config") {
      // Settings continues the same session — no summarize prompt.
      props.onSettings();
      exit();
      return;
    }
    const nextHist = [...localHistory, line];
    setLocalHistory(nextHist);
    setHistIdx(nextHist.length);
    props.onHistoryPush(line);
    dispatch({ type: "submit-user", text: line });
    void props.onSubmit(line);
  };

  useInput((ch, key) => {
    // 1. Selector overlay captures all input.
    if (state.selector) {
      const spec = state.selector.spec;
      if (key.ctrl && ch === "c") {
        resolveSelector(spec.escResolvesTo);
        requestExit();
      } else if (key.upArrow) {
        setSelIndex((i) => (i - 1 + spec.options.length) % spec.options.length);
      } else if (key.downArrow) {
        setSelIndex((i) => (i + 1) % spec.options.length);
      } else if (key.escape) {
        resolveSelector(spec.escResolvesTo);
      } else if (key.return) {
        resolveSelector(selIndex);
      }
      return;
    }

    // 2. Ctrl-C runs the exit flow (or force-quits mid-summarize).
    if (key.ctrl && ch === "c") {
      requestExit();
      return;
    }

    // 3. While a turn / summarization runs, ignore edits (Ctrl-C still lands above).
    if (state.busy) return;

    // 4. Autocomplete list steals navigation/confirm keys while visible.
    if (acVisible) {
      if (key.upArrow) {
        setAcIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (key.downArrow) {
        setAcIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (key.tab) {
        const pick = suggestions[acIndex] ?? suggestions[0]!;
        setInput(pick.name);
        setCursor(pick.name.length);
        setDismissedFor(pick.name);
        return;
      }
      if (key.return) {
        const pick = suggestions[acIndex] ?? suggestions[0]!;
        submit(pick.name);
        return;
      }
      if (key.escape) {
        setDismissedFor(input);
        return;
      }
      // Any other key falls through so typing keeps filtering.
    }

    // 5. Normal input editing + history.
    if (key.return) {
      submit(input);
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(input.length, c + 1));
      return;
    }
    if (key.upArrow) {
      if (histIdx > 0) {
        const idx = histIdx - 1;
        const v = localHistory[idx] ?? "";
        setHistIdx(idx);
        setInput(v);
        setCursor(v.length);
      }
      return;
    }
    if (key.downArrow) {
      if (histIdx < localHistory.length) {
        const idx = histIdx + 1;
        const v = localHistory[idx] ?? "";
        setHistIdx(idx);
        setInput(v);
        setCursor(v.length);
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setInput((s) => s.slice(0, cursor - 1) + s.slice(cursor));
        setCursor((c) => Math.max(0, c - 1));
      }
      return;
    }
    if (key.tab || key.ctrl || key.meta || !ch) return;
    setInput((s) => s.slice(0, cursor) + ch + s.slice(cursor));
    setCursor((c) => c + ch.length);
  });

  type StaticEntry = { id: number; banner: true } | TranscriptItem;
  const staticItems: StaticEntry[] = props.showBanner
    ? [{ id: 0, banner: true }, ...state.items]
    : state.items;

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(entry) =>
          "banner" in entry ? (
            <Banner key="banner" version={props.version} model={props.model} />
          ) : (
            <Item key={entry.id} item={entry} />
          )
        }
      </Static>

      <LiveRegion
        assistant={state.liveAssistant}
        tools={state.liveTools}
        busy={state.busy}
        busyLabel={state.busyLabel}
      />

      {state.selector ? (
        <SelectPrompt spec={state.selector.spec} selectedIndex={selIndex} />
      ) : (
        <>
          {acVisible ? <SuggestionList items={suggestions} selectedIndex={acIndex} /> : null}
          <InputBar
            value={input}
            cursor={cursor}
            hintRight={props.model}
            statusLeft={props.statusLeft}
            statusRight={props.statusRight}
            disabled={state.busy}
          />
        </>
      )}
    </Box>
  );
}
