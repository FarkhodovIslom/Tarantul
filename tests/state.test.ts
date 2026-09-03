import { describe, expect, it } from "bun:test";
import {
  appSliceReduce,
  applyUiEvent,
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
  type LiveSlice,
  type TranscriptSlice,
  type UiSlice,
} from "../src/cli/ink/state.js";
import type { TranscriptItem, UiEvent } from "../src/cli/ink/types.js";

describe("state reducer helpers", () => {
  describe("insertChar", () => {
    it("inserts at the cursor position and advances the cursor", () => {
      const before: UiSlice = { ...initialUiSlice, input: "ab", cursor: 1 };
      const after = insertChar(before, "X");
      expect(after.input).toBe("aXb");
      expect(after.cursor).toBe(2);
    });

    it("appends at the end of the string", () => {
      const before: UiSlice = { ...initialUiSlice, input: "abc", cursor: 3 };
      const after = insertChar(before, "d");
      expect(after.input).toBe("abcd");
      expect(after.cursor).toBe(4);
    });
  });

  describe("deleteBeforeCursor", () => {
    it("removes the character before the cursor and decrements the cursor", () => {
      const before: UiSlice = { ...initialUiSlice, input: "abcd", cursor: 2 };
      const after = deleteBeforeCursor(before);
      expect(after.input).toBe("acd");
      expect(after.cursor).toBe(1);
    });

    it("is a no-op when the cursor is at position 0", () => {
      const before: UiSlice = { ...initialUiSlice, input: "abc", cursor: 0 };
      const after = deleteBeforeCursor(before);
      expect(after.input).toBe("abc");
      expect(after.cursor).toBe(0);
    });
  });

  describe("cursor moves", () => {
    const seeded: UiSlice = { ...initialUiSlice, input: "abcd", cursor: 2 };

    it("moveCursorLeft clamps at 0", () => {
      const a = moveCursorLeft({ ...seeded, cursor: 0 });
      expect(a.cursor).toBe(0);
      const b = moveCursorLeft(seeded);
      expect(b.cursor).toBe(1);
    });

    it("moveCursorRight clamps at input.length", () => {
      const a = moveCursorRight({ ...seeded, cursor: 4 });
      expect(a.cursor).toBe(4);
      const b = moveCursorRight(seeded);
      expect(b.cursor).toBe(3);
    });
  });

  it("resetInput clears input and cursor", () => {
    const seeded: UiSlice = {
      ...initialUiSlice,
      input: "hello",
      cursor: 5,
      dismissedFor: "x",
    };
    const after = resetInput(seeded);
    expect(after.input).toBe("");
    expect(after.cursor).toBe(0);
    expect(after.dismissedFor).toBe(null);
  });
});

describe("applyUiEvent — transcript + live slices", () => {
  function emptyTranscript(): TranscriptSlice {
    return initialTranscriptSlice(1, []);
  }

  function emptyLive(): LiveSlice {
    return initialLiveSlice;
  }

  it("assistant-delta accumulates into the live slice", () => {
    const t = emptyTranscript();
    const l = emptyLive();
    const e: UiEvent = { t: "assistant-delta", text: "Hello" };
    const out = applyUiEvent(t, l, e);
    expect(out.transcript.items).toHaveLength(0);
    expect(out.live.assistant).toBe("Hello");
  });

  it("assistant-delta with empty text is a no-op", () => {
    const t = emptyTranscript();
    const l = emptyLive();
    const before = applyUiEvent(t, l, { t: "assistant-delta", text: "" });
    expect(before.live.assistant).toBe("");
    expect(before.transcript).toBe(t);
  });

  it("assistant-end flushes live assistant into a finalized transcript item", () => {
    let t = emptyTranscript();
    let l = emptyLive();
    ({ live: l } = applyUiEvent(t, l, { t: "assistant-delta", text: "Hi there" }));
    ({ transcript: t, live: l } = applyUiEvent(t, l, { t: "assistant-end", model: "gpt-x" }));
    expect(l.assistant).toBe("");
    expect(t.items).toHaveLength(1);
    const item = t.items[0]!;
    expect(item.kind).toBe("assistant");
    expect((item as { text: string }).text).toBe("Hi there");
    expect((item as { model: string }).model).toBe("gpt-x");
  });

  it("assistant-end with empty live assistant is a no-op", () => {
    const t = emptyTranscript();
    const l = emptyLive();
    const out = applyUiEvent(t, l, { t: "assistant-end", model: "gpt-x" });
    expect(out.transcript.items).toHaveLength(0);
    expect(out.transcript).toBe(t);
  });

  it("tool-start flushes a pending assistant into the transcript first", () => {
    let t = emptyTranscript();
    let l = emptyLive();
    ({ live: l } = applyUiEvent(t, l, { t: "assistant-delta", text: "Thinking…" }));
    ({ transcript: t, live: l } = applyUiEvent(t, l, {
      t: "tool-start",
      id: "t1",
      label: "shell",
    }));
    expect(l.assistant).toBe("");
    expect(l.tools).toHaveLength(1);
    expect(t.items).toHaveLength(1);
    expect(t.items[0]!.kind).toBe("assistant");
  });

  it("tool-end finalizes a tool item and removes it from the live list", () => {
    let t = emptyTranscript();
    let l = emptyLive();
    ({ transcript: t, live: l } = applyUiEvent(t, l, {
      t: "tool-start",
      id: "t1",
      label: "shell",
    }));
    ({ transcript: t, live: l } = applyUiEvent(t, l, {
      t: "tool-end",
      id: "t1",
      ok: true,
      detail: "ok",
    }));
    expect(l.tools).toHaveLength(0);
    expect(t.items).toHaveLength(1);
    expect(t.items[0]!.kind).toBe("tool");
  });

  it("notice appends an info notice item to the transcript", () => {
    const t = emptyTranscript();
    const l = emptyLive();
    const out = applyUiEvent(t, l, { t: "notice", text: "hi", tone: "info" });
    expect(out.transcript.items).toHaveLength(1);
    expect(out.transcript.items[0]!.kind).toBe("notice");
  });

  it("busy true sets busy and label; busy false clears them", () => {
    let t = emptyTranscript();
    let l = emptyLive();
    ({ transcript: t, live: l } = applyUiEvent(t, l, {
      t: "busy",
      value: true,
      label: "Thinking…",
    }));
    expect(l.busy).toBe(true);
    expect(l.busyLabel).toBe("Thinking…");
    ({ transcript: t, live: l } = applyUiEvent(t, l, { t: "busy", value: false }));
    expect(l.busy).toBe(false);
    expect(l.busyLabel).toBe(null);
  });

  it("clear empties the transcript and bumps the generation counter", () => {
    const items: TranscriptItem[] = [
      { id: 1, kind: "user", text: "hi" },
      { id: 2, kind: "assistant", text: "hello", model: "m", time: "00:00" },
    ];
    const t = initialTranscriptSlice(3, items);
    const out = applyUiEvent(t, emptyLive(), { t: "clear" });
    expect(out.transcript.items).toHaveLength(0);
    expect(out.transcript.generation).toBe(1);
  });

  it("select + replay do not touch the transcript/live slices directly", () => {
    const t = emptyTranscript();
    const l = emptyLive();
    const sel = applyUiEvent(t, l, {
      t: "select",
      spec: { title: "x", options: [{ label: "a" }], escResolvesTo: null, accent: "info" },
      resolve: () => {},
    });
    expect(sel.transcript).toBe(t);
    expect(sel.live).toBe(l);

    const rep = applyUiEvent(t, l, { t: "replay", entries: [] });
    expect(rep.transcript).toBe(t);
    expect(rep.live).toBe(l);
  });
});

describe("appSliceReduce — combined transcript+live reducer", () => {
  function seed(): { transcript: TranscriptSlice; live: LiveSlice } {
    return {
      transcript: initialTranscriptSlice(1, []),
      live: { ...initialLiveSlice },
    };
  }

  it("streams then ends finalizes the assistant item", () => {
    let s = seed();
    s = appSliceReduce(s, { type: "event", e: { t: "assistant-delta", text: "Hello " } });
    s = appSliceReduce(s, { type: "event", e: { t: "assistant-delta", text: "world" } });
    s = appSliceReduce(s, { type: "event", e: { t: "assistant-end", model: "gpt-x" } });
    expect(s.live.assistant).toBe("");
    expect(s.transcript.items).toHaveLength(1);
    const item = s.transcript.items[0]!;
    expect(item.kind).toBe("assistant");
    expect((item as { text: string }).text).toBe("Hello world");
    expect((item as { model: string }).model).toBe("gpt-x");
  });

  it("tool-start flushes pending assistant text into the transcript before registering the tool", () => {
    let s = seed();
    s = appSliceReduce(s, { type: "event", e: { t: "assistant-delta", text: "thinking…" } });
    s = appSliceReduce(s, {
      type: "event",
      e: { t: "tool-start", id: "t1", label: "exec(git status)" },
    });
    expect(s.live.assistant).toBe("");
    expect(s.live.tools).toHaveLength(1);
    expect(s.transcript.items).toHaveLength(1);
    const assistantItem = s.transcript.items[0]!;
    expect(assistantItem.kind).toBe("assistant");
    expect((assistantItem as { text: string }).text).toBe("thinking…");
  });

  it("tool-end preserves the label that was registered on tool-start", () => {
    let s = seed();
    s = appSliceReduce(s, {
      type: "event",
      e: { t: "tool-start", id: "t1", label: "exec(git status)" },
    });
    s = appSliceReduce(s, {
      type: "event",
      e: { t: "tool-end", id: "t1", ok: true, detail: "ok" },
    });
    expect(s.live.tools).toHaveLength(0);
    expect(s.transcript.items).toHaveLength(1);
    const toolItem = s.transcript.items[0]!;
    expect(toolItem.kind).toBe("tool");
    expect((toolItem as { label: string }).label).toBe("exec(git status)");
  });

  it("clear empties items, bumps generation, and clears live streaming buffers", () => {
    const items: TranscriptItem[] = [
      { id: 1, kind: "user", text: "hi" },
      { id: 2, kind: "assistant", text: "hello", model: "m", time: "00:00" },
    ];
    let s = {
      transcript: initialTranscriptSlice(3, items),
      live: { ...initialLiveSlice, assistant: "leftover", tools: [{ id: "x", label: "l" }] },
    };
    s = appSliceReduce(s, { type: "event", e: { t: "clear" } });
    expect(s.transcript.items).toHaveLength(0);
    expect(s.transcript.generation).toBe(1);
    expect(s.live.assistant).toBe("");
    expect(s.live.tools).toHaveLength(0);
  });

  it("replay pushes user + assistant entries with empty model/time", () => {
    let s = seed();
    s = appSliceReduce(s, {
      type: "event",
      e: {
        t: "replay",
        entries: [
          { role: "user", text: "a" },
          { role: "assistant", text: "b" },
        ],
      },
    });
    expect(s.transcript.items).toHaveLength(2);
    const first = s.transcript.items[0]!;
    const second = s.transcript.items[1]!;
    expect(first.kind).toBe("user");
    expect(second.kind).toBe("assistant");
    expect((second as { model: string }).model).toBe("");
    expect((second as { time: string }).time).toBe("");
  });

  it("submit-user pushes a user item and does not touch live", () => {
    let s = seed();
    s = appSliceReduce(s, { type: "submit-user", text: "hello" });
    expect(s.transcript.items).toHaveLength(1);
    expect(s.transcript.items[0]!.kind).toBe("user");
    expect((s.transcript.items[0]! as { text: string }).text).toBe("hello");
    expect(s.live).toEqual({ ...initialLiveSlice });
  });
});

describe("historyPrev / historyNext — pure input history navigation", () => {
  const entries = ["first", "second", "third"];

  it("historyPrev returns null at the oldest entry", () => {
    const ui: UiSlice = { ...initialUiSlice, histIdx: 0 };
    expect(historyPrev(ui, entries)).toBeNull();
  });

  it("historyPrev loads the most-recent entry when starting from `length`", () => {
    const ui: UiSlice = { ...initialUiSlice, histIdx: entries.length };
    const next = historyPrev(ui, entries);
    expect(next).not.toBeNull();
    expect(next!.histIdx).toBe(entries.length - 1);
    expect(next!.input).toBe("third");
    expect(next!.cursor).toBe("third".length);
  });

  it("historyNext returns null when already past the end", () => {
    const ui: UiSlice = { ...initialUiSlice, histIdx: entries.length };
    expect(historyNext(ui, entries)).toBeNull();
  });

  it("historyNext advances and clears the input when moving past the last entry", () => {
    const ui: UiSlice = { ...initialUiSlice, histIdx: entries.length - 1, input: "third", cursor: 5 };
    const next = historyNext(ui, entries);
    expect(next).not.toBeNull();
    expect(next!.histIdx).toBe(entries.length);
    expect(next!.input).toBe("");
    expect(next!.cursor).toBe(0);
  });
});
