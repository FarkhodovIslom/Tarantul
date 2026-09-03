import { Box, useApp, useInput, useStdout } from "ink";
import { memo, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type React from "react";
import { markdownToAnsi } from "../render.js";
import { filterCommands } from "./commands.js";
import { Banner, InputBar, Item, LiveRegion, SelectPrompt, SuggestionList } from "./components.js";
import { StatusBar, TipBar } from "./primitives.js";
import { ScrollThumb } from "./ScrollThumb.js";
import {
  appSliceReduce,
  deleteBeforeCursor,
  historyNext,
  historyPrev,
  initialLiveSlice,
  initialTranscriptSlice,
  initialUiSlice,
  insertChar,
  moveCursorLeft,
  moveCursorRight,
  resetInput,
} from "./state.js";
import type { UiSlice } from "./state.js";
import { rows } from "./theme.js";
import type { ReplayEntry, SelectorSpec, TranscriptItem, UiBridge } from "./types.js";
import { WindowedList, type WindowedListRef } from "./WindowedList.js";
import { TitleBar } from "./TitleBar.js";

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
  /** Aborts the in-flight turn. Returns false if nothing was running. */
  onStop: () => boolean;
}

interface PendingSelector {
  spec: SelectorSpec;
  resolve: (index: number | null) => void;
}

function seedItems(initial: ReplayEntry[]): { nextId: number; items: TranscriptItem[] } {
  let nextId = 1;
  const items: TranscriptItem[] = [];
  for (const entry of initial) {
    if (entry.role === "user") {
      items.push({ id: nextId++, kind: "user", text: entry.text });
    } else {
      items.push({ id: nextId++, kind: "assistant", text: entry.text, model: "", time: "" });
    }
  }
  return { nextId, items };
}

// ---------------------------------------------------------------------------
// Markdown memoization. Caching the parsed ANSI by `${id}:${hash}` keeps the
// expensive render step O(1) on subsequent re-renders of finalized items.
// ---------------------------------------------------------------------------

function textHash(s: string): number {
  let h = s.length ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x85ebca6b);
  return h >>> 0;
}

const markdownCache = new Map<string, string>();

function cachedMarkdown(id: number, text: string): string {
  const key = `${id}:${textHash(text)}`;
  const hit = markdownCache.get(key);
  if (hit !== undefined) return hit;
  const rendered = markdownToAnsi(text);
  // Bound the cache so a very long session does not grow without limit.
  if (markdownCache.size > 2048) markdownCache.clear();
  markdownCache.set(key, rendered);
  return rendered;
}

// ---------------------------------------------------------------------------
// Memoized item wrapper. Assistant items pre-compute their markdown render so
// the inner Item component stays free of expensive work.
// ---------------------------------------------------------------------------

const MemoizedItem = memo(
  function MemoizedItem({ item }: { item: TranscriptItem }) {
    if (item.kind === "assistant") {
      return <Item item={item} renderedText={cachedMarkdown(item.id, item.text)} />;
    }
    return <Item item={item} />;
  },
  (prev, next) => prev.item === next.item,
);

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // -------------------------------------------------------------------------
  // One combined reducer for the transcript + live slices. They are coupled
  // by events (assistant-end / tool-start / tool-end span both), so a single
  // reducer is the correct shape — see appSliceReduce in state.ts.
  // -------------------------------------------------------------------------

  const seeded = useMemo(() => seedItems(props.initialTranscript), [props.initialTranscript]);
  const [slices, dispatchSlice] = useReducer(appSliceReduce, undefined, () => ({
    transcript: initialTranscriptSlice(seeded.nextId, seeded.items),
    live: initialLiveSlice,
  }));
  const transcript = slices.transcript;
  const live = slices.live;

  // -------------------------------------------------------------------------
  // UiSlice + history + selector. `localHistory` lives outside the reducer
  // because it is only touched on submit (rare) and history navigation.
  // `ui.histIdx` is seeded to `history.length` so the first ↑ loads the most
  // recent entry instead of the oldest (was 0 → jumped to entries[0]).
  // -------------------------------------------------------------------------

  const [ui, setUi] = useState<UiSlice>(() => ({
    ...initialUiSlice,
    histIdx: props.history.length,
  }));
  const [history, setHistory] = useState<string[]>(props.history);
  const [selector, setSelector] = useState<PendingSelector | null>(null);

  const exitingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const scrollRef = useRef<WindowedListRef>(null);

  // -------------------------------------------------------------------------
  // Auto-scroll: throttled to once every 50 ms. Bursty token streams would
  // otherwise hammer the measure path inside the WindowedList / live region.
  // We track `scrollOffset` so manual scroll-up keeps the user where they
  // are — see also the follow-bottom state below (#8-modul foundation).
  // -------------------------------------------------------------------------

  const [scrollOffset, setScrollOffset] = useState(0);
  const [followBottom, setFollowBottom] = useState(true);

  // Real content height reported by the WindowedList. Used by the scroll thumb
  // so its proportional geometry reflects the actual transcript height
  // instead of the viewport estimate. Named distinctly from the derived
  // `contentHeight` below (the viewport budget) to avoid shadowing.
  const [transcriptContentHeight, setTranscriptContentHeight] = useState(0);

  const autoScrollPendingRef = useRef(false);
  useEffect(() => {
    if (!followBottom) return;
    const ref = scrollRef.current;
    if (!ref) return;
    if (autoScrollPendingRef.current) return;
    autoScrollPendingRef.current = true;
    const handle = setTimeout(() => {
      autoScrollPendingRef.current = false;
      ref.scrollToBottom();
      // After auto-scroll, the ref is at the bottom; reflect it in state.
      setScrollOffset(ref.getScrollOffset());
    }, 50);
    return () => clearTimeout(handle);
  }, [transcript.items.length, live.assistant, live.tools.length, followBottom]);

  // -------------------------------------------------------------------------
  // Re-measure on terminal resize. Ink 7's useStdout exposes the same stdout
  // we listen on directly; the original duplicate `process.stdout` listener
  // is no longer needed.
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      scrollRef.current?.remeasure();
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // -------------------------------------------------------------------------
  // Bridge subscription. Events are dispatched into the single slice reducer.
  // The selector is set imperatively because its `resolve` callback must come
  // from the imperative side, not from React state. Returning the unsubscribe
  // function from this effect so React actually cleans up the listener.
  // -------------------------------------------------------------------------

  useEffect(() => {
    return props.bridge.onEvent((e) => {
      dispatchSlice({ type: "event", e });
      if (e.t === "select") setSelector({ spec: e.spec, resolve: e.resolve });
    });
  }, [props.bridge]);

  // Reset the highlight to the first option whenever a new selector appears.
  useEffect(() => {
    if (selector) setUi((s) => ({ ...s, selIndex: 0 }));
  }, [selector]);

  useEffect(() => {
    if (!live.busy) stopRequestedRef.current = false;
  }, [live.busy]);

  // -------------------------------------------------------------------------
  // Derived render-time values
  // -------------------------------------------------------------------------

  const suggestions = ui.input !== ui.dismissedFor ? filterCommands(ui.input) : [];
  const acVisible = !selector && !live.busy && suggestions.length > 0;

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
    if (!selector) return;
    const pending = selector;
    setSelector(null);
    pending.resolve(index);
  };

  const submit = (raw: string): void => {
    const line = raw.trim();
    setUi((s) => resetInput(s));
    if (!line) return;
    if (line === "exit" || line === "quit") {
      requestExit();
      return;
    }
    if (line === "/settings" || line === "/config") {
      props.onSettings();
      exit();
      return;
    }
    setHistory((h) => [...h, line]);
    setUi((s) => ({ ...s, histIdx: history.length + 1 }));
    props.onHistoryPush(line);
    dispatchSlice({ type: "submit-user", text: line });
    void props.onSubmit(line);
  };

  // -------------------------------------------------------------------------
  // Keyboard input — split into pure helpers for readability.
  // -------------------------------------------------------------------------

  type KeyFlags = {
    ctrl?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    escape?: boolean;
    return?: boolean;
    backspace?: boolean;
    delete?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
    tab?: boolean;
    meta?: boolean;
  };

  const handleCtrlC = (ch: string | undefined, key: KeyFlags): boolean => {
    if (!(key.ctrl && ch === "c")) return false;
    if (live.busy) {
      if (stopRequestedRef.current) requestExit();
      else {
        stopRequestedRef.current = true;
        props.onStop();
      }
    } else {
      requestExit();
    }
    return true;
  };

  const handleSelector = (ch: string | undefined, key: KeyFlags): boolean => {
    if (!selector) return false;
    const spec = selector.spec;
    if (key.ctrl && ch === "c") {
      resolveSelector(spec.escResolvesTo);
      requestExit();
      return true;
    }
    if (key.upArrow) {
      setUi((s) => ({
        ...s,
        selIndex: (s.selIndex - 1 + spec.options.length) % spec.options.length,
      }));
      return true;
    }
    if (key.downArrow) {
      setUi((s) => ({ ...s, selIndex: (s.selIndex + 1) % spec.options.length }));
      return true;
    }
    if (key.escape) {
      resolveSelector(spec.escResolvesTo);
      return true;
    }
    if (key.return) {
      resolveSelector(ui.selIndex);
      return true;
    }
    return false;
  };

  const handleBusy = (ch: string | undefined, key: KeyFlags): boolean => {
    if (!live.busy) return false;
    if (key.return) {
      if (ui.input.trim().toLowerCase() === "/stop") {
        setUi((s) => resetInput(s));
        dispatchSlice({ type: "submit-user", text: "/stop" });
        if (stopRequestedRef.current) requestExit();
        else {
          stopRequestedRef.current = true;
          props.onStop();
        }
      }
      return true;
    }
    if (key.leftArrow) {
      setUi((s) => moveCursorLeft(s));
      return true;
    }
    if (key.rightArrow) {
      setUi((s) => moveCursorRight(s));
      return true;
    }
    if (key.backspace || key.delete) {
      setUi((s) => deleteBeforeCursor(s));
      return true;
    }
    if (key.tab || key.ctrl || key.meta || !ch) return true;
    setUi((s) => insertChar(s, ch));
    return true;
  };

  const handleAutocomplete = (ch: string | undefined, key: KeyFlags): boolean => {
    if (!acVisible) return false;
    if (key.upArrow) {
      setUi((s) => ({
        ...s,
        acIndex: (s.acIndex - 1 + suggestions.length) % suggestions.length,
      }));
      return true;
    }
    if (key.downArrow) {
      setUi((s) => ({ ...s, acIndex: (s.acIndex + 1) % suggestions.length }));
      return true;
    }
    if (key.tab) {
      const pick = suggestions[ui.acIndex] ?? suggestions[0];
      if (!pick) return true;
      setUi((s) => ({ ...s, input: pick.name, cursor: pick.name.length, dismissedFor: pick.name }));
      return true;
    }
    if (key.return) {
      const pick = suggestions[ui.acIndex] ?? suggestions[0];
      if (!pick) return true;
      submit(pick.name);
      return true;
    }
    if (key.escape) {
      setUi((s) => ({ ...s, dismissedFor: s.input }));
      return true;
    }
    return false;
  };

  const handleIdle = (ch: string | undefined, key: KeyFlags): boolean => {
    const viewport = Math.max(1, Math.floor((stdout?.rows ?? 24) / 2));
    if (key.pageUp) {
      scrollRef.current?.scrollBy(-viewport);
      setFollowBottom(false);
      return true;
    }
    if (key.pageDown) {
      scrollRef.current?.scrollBy(viewport);
      // If we land on (or past) the bottom, re-engage auto-scroll.
      const ref = scrollRef.current;
      if (ref && ref.getScrollOffset() >= ref.getBottomOffset() - 1) {
        setFollowBottom(true);
      }
      return true;
    }
    if (key.return) {
      submit(ui.input);
      return true;
    }
    if (key.leftArrow) {
      setUi((s) => moveCursorLeft(s));
      return true;
    }
    if (key.rightArrow) {
      setUi((s) => moveCursorRight(s));
      return true;
    }
    if (key.upArrow) {
      const next = historyPrev(ui, history);
      if (next) setUi(next);
      return true;
    }
    if (key.downArrow) {
      const next = historyNext(ui, history);
      if (next) setUi(next);
      return true;
    }
    if (key.backspace || key.delete) {
      setUi((s) => deleteBeforeCursor(s));
      return true;
    }
    if (key.tab || key.ctrl || key.meta || !ch) return true;
    setUi((s) => insertChar(s, ch));
    return true;
  };

  useInput((ch, key) => {
    const k = key as KeyFlags;
    if (handleCtrlC(ch, k)) return;
    if (handleSelector(ch, k)) return;
    if (handleBusy(ch, k)) return;
    if (handleAutocomplete(ch, k)) return;
    handleIdle(ch, k);
  });

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  const screenRows = stdout?.rows ?? 24;
  const contentHeight = Math.max(6, screenRows - rows.pinned);

  const showBannerNow = props.showBanner && transcript.generation === 0;

  // Windowed items: optional banner (when generation === 0) plus the finalized
  // transcript. Each entry carries a stable React node + key so the
  // windowed list can skip re-rendering off-screen rows.
  const renderedEntries = useMemo<ReadonlyArray<{ key: string; node: React.ReactNode }>>(() => {
    const entries: { key: string; node: React.ReactNode }[] = [];
    if (showBannerNow) {
      entries.push({
        key: "banner",
        node: <Banner key="banner" version={props.version} model={props.model} />,
      });
    }
    for (const item of transcript.items) {
      entries.push({
        key: `item-${item.id}`,
        node: <MemoizedItem key={item.id} item={item} />,
      });
    }
    return entries;
  }, [showBannerNow, props.version, props.model, transcript.items]);

  // Reserve rows for the live region (assistant + tools + spinner) so the
  // windowed list's viewport math stays accurate even while streaming.
  const liveRows = live.busy || live.assistant || live.tools.length > 0 ? 6 : 0;
  const listViewport = Math.max(3, contentHeight - liveRows);

  const itemKeyFn = useMemo(
    () =>
      (entry: { key: string; node: React.ReactNode }): string =>
        entry.key,
    [],
  );

  const renderItemFn = useMemo(
    () =>
      (entry: { key: string; node: React.ReactNode }): React.ReactNode =>
        entry.node,
    [],
  );

  return (
    <Box flexDirection="column" height={screenRows} width="100%">
      {/* ── TOP: pinned title bar ── */}
      {/*<TitleBar version={props.version} model={props.model} />*/}

      {/* ── MIDDLE: scrollable content viewport (windowed + scrollbar) ── */}
      <Box flexDirection="row" height={listViewport} overflow="hidden">
        <Box flexShrink={1} flexGrow={1} overflow="hidden">
          <WindowedList
            ref={scrollRef}
            items={renderedEntries}
            itemKey={itemKeyFn}
            renderItem={renderItemFn}
            viewportHeight={listViewport}
            estimatedHeight={3}
            overscan={6}
            scrollOffset={scrollOffset}
            onScroll={setScrollOffset}
            onContentHeightChange={setTranscriptContentHeight}
          />
        </Box>
        <ScrollThumb
          contentHeight={transcriptContentHeight}
          viewportHeight={listViewport}
          scrollOffset={scrollOffset}
          trackHeight={listViewport}
        />
      </Box>

      {/* ── PINNED: live streaming region (always at the bottom) ── */}
      <LiveRegion
        assistant={live.assistant}
        tools={live.tools}
        busy={live.busy}
        busyLabel={live.busyLabel}
      />

      {/* ── BOTTOM: selector overlay OR input + hints ── */}
      {selector ? (
        <SelectPrompt spec={selector.spec} selectedIndex={ui.selIndex} />
      ) : (
        <>
          {acVisible ? <SuggestionList items={suggestions} selectedIndex={ui.acIndex} /> : null}
          <InputBar
            value={ui.input}
            cursor={ui.cursor}
            model={props.model}
            mode="Build"
            disabled={live.busy}
          />
        </>
      )}

      {/* ── PINNED: tip + status bar ── */}
      <TipBar />
      <StatusBar left={props.statusLeft} right={props.statusRight} />
    </Box>
  );
}
