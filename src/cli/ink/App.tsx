import { Box, Static, useApp, useInput } from "ink";
import type React from "react";
import { useEffect, useReducer, useState } from "react";
import type { PermissionRequest } from "../../agent/tools/base.js";
import {
  Banner,
  InputBar,
  Item,
  LiveRegion,
  PERMISSION_OPTIONS,
  PermissionPrompt,
} from "./components.js";
import type { PermDecision, RunningTool, TranscriptItem, UiBridge, UiEvent } from "./types.js";

/** Index → decision, matching {@link PERMISSION_OPTIONS}'s display order. */
const PERMISSION_DECISIONS: readonly PermDecision[] = ["yes", "always", "no"];

export interface AppProps {
  bridge: UiBridge;
  version: string;
  model: string;
  statusLeft: string;
  statusRight: string;
  history: string[];
  /** False on remounts after a `/settings` visit — the banner shows once per process. */
  showBanner: boolean;
  /** Runs one submitted line (slash command or message). Drives bridge events. */
  onSubmit: (line: string) => Promise<void>;
  /** Persist a line to the shared CLI history file. */
  onHistoryPush: (line: string) => void;
  /** Called when the user types `/settings` — the caller unmounts this app,
   *  runs the settings menu (which needs exclusive raw stdin), then remounts. */
  onSettings: () => void;
}

interface PendingPermission {
  req: PermissionRequest;
  resolve: (decision: PermDecision) => void;
}

interface State {
  nextId: number;
  items: TranscriptItem[];
  liveAssistant: string;
  liveTools: RunningTool[];
  busy: boolean;
  permission: PendingPermission | null;
}

type Action =
  | { type: "submit-user"; text: string }
  | { type: "set-permission"; value: PendingPermission | null }
  | { type: "event"; e: UiEvent };

function timeStamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function push(state: State, item: TranscriptItem): State {
  return { ...state, nextId: state.nextId + 1, items: [...state.items, item] };
}

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "submit-user":
      return push(state, { id: state.nextId, kind: "user", text: action.text });
    case "set-permission":
      return { ...state, permission: action.value };
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
        s = {
          ...push(s, {
            id: s.nextId,
            kind: "assistant",
            text: s.liveAssistant,
            model: "",
            time: "",
          }),
          liveAssistant: "",
        };
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
      return { ...state, busy: e.value };
    case "permission":
      return { ...state, permission: { req: e.req, resolve: e.resolve } };
    case "clear":
      return { ...state, items: [], liveAssistant: "", liveTools: [] };
    default:
      return state;
  }
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reduce, {
    nextId: 1,
    items: [],
    liveAssistant: "",
    liveTools: [],
    busy: false,
    permission: null,
  });

  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [histIdx, setHistIdx] = useState(props.history.length);
  const [localHistory, setLocalHistory] = useState(props.history);
  const [permIndex, setPermIndex] = useState(0);

  useEffect(() => props.bridge.onEvent((e) => dispatch({ type: "event", e })), [props.bridge]);

  // Reset the highlighted option to "Yes" whenever a new permission prompt
  // appears, so a stale selection from a prior prompt never carries over.
  useEffect(() => {
    if (state.permission) setPermIndex(0);
  }, [state.permission]);

  const submit = (raw: string): void => {
    const line = raw.trim();
    setInput("");
    setCursor(0);
    if (!line) return;
    if (line === "exit" || line === "quit") {
      exit();
      return;
    }
    if (line === "/settings" || line === "/config") {
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

  const answerPermission = (decision: PermDecision): void => {
    const p = state.permission;
    if (!p) return;
    dispatch({ type: "set-permission", value: null });
    p.resolve(decision);
  };

  useInput((ch, key) => {
    if (state.permission) {
      if (key.upArrow) {
        setPermIndex((i) => (i - 1 + PERMISSION_OPTIONS.length) % PERMISSION_OPTIONS.length);
      } else if (key.downArrow) {
        setPermIndex((i) => (i + 1) % PERMISSION_OPTIONS.length);
      } else if (key.escape) {
        answerPermission("no");
      } else if (key.return) {
        // A terminal that forwards Cmd+Enter distinctly reports it as a
        // meta-modified return; plain Enter (the only guaranteed signal —
        // most terminals never forward Cmd combos to a tty at all) confirms
        // the highlighted option either way.
        answerPermission(PERMISSION_DECISIONS[permIndex] ?? "no");
      }
      return;
    }

    if (key.ctrl && ch === "c") {
      exit();
      return;
    }
    if (state.busy) return;

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
    if (key.ctrl || key.meta || !ch) return;
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

      <LiveRegion assistant={state.liveAssistant} tools={state.liveTools} busy={state.busy} />

      {state.permission ? (
        <PermissionPrompt
          tool={state.permission.req.tool}
          action={state.permission.req.action}
          reason={state.permission.req.reason}
          selectedIndex={permIndex}
        />
      ) : (
        <InputBar
          value={input}
          cursor={cursor}
          hintRight={props.model}
          statusLeft={props.statusLeft}
          statusRight={props.statusRight}
          disabled={state.busy}
        />
      )}
    </Box>
  );
}
