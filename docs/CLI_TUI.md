# Tarantul CLI — Fullscreen TUI Architecture

The interactive CLI (`tarantul agent`) renders through an Ink-based fullscreen
TUI mounted inside the terminal's alternate screen buffer. As of the most
recent refactor it ships with a split-state model, manual windowing, native
cursor control, mouse support, and a rendered scrollbar.

This document explains the architecture so future changes don't accidentally
regress performance or break the agent ↔ UI contract.

## High-level layout

```
┌─ TitleBar ──────────────────────────────────────────────────────────────┐
│  ● ● ●   Tarantul                        gpt-4o      v0.0.1            │
├──────────────────────────────────────────────────────────┬──────────────┤
│  WindowedList (memo'd transcript items)                  │  ScrollThumb │
│    ▲                                                    │      █       │
│    │ pageUp / mouse wheel_up                            │      █       │
│                                                          │      █       │
│    ▼ pageDown / mouse wheel_down                        │              │
├──────────────────────────────────────────────────────────────────────────┤
│  LiveRegion  (assistant streaming, running tools, spinner)                │
├──────────────────────────────────────────────────────────────────────────┤
│  Bottom zone  —  SelectPrompt | SuggestionList + InputBar                │
├──────────────────────────────────────────────────────────────────────────┤
│  TipBar   "● Tip …"                                                      │
├──────────────────────────────────────────────────────────────────────────┤
│  StatusBar   ws:branch                          v0.0.1                   │
└──────────────────────────────────────────────────────────────────────────┘
```

## Files

| Path | Purpose |
| --- | --- |
| `src/cli/ink/state.ts` | Split-state slice types + pure helpers + UiEvent → slice applier. |
| `src/cli/ink/App.tsx` | The single top-level React component. Hosts the reducers, hooks, and layout. |
| `src/cli/ink/components.tsx` | Memoized presentational components (`Banner`, `Item`, `LiveRegion`, `InputBar`, `SelectPrompt`, `SuggestionList`). |
| `src/cli/ink/WindowedList.tsx` | Manual windowing list with the same ref API as `ink-scroll-view`. |
| `src/cli/ink/ScrollThumb.tsx` | Single-column scrollbar drawn next to the windowed viewport. |
| `src/cli/ink/TitleBar.tsx` | Pinned top bar (traffic lights + app name + model). |
| `src/cli/ink/CommandPalette.tsx` | Slash-command modal — opened by `Ctrl+/` or `/help`. |
| `src/cli/ink/useTerminalCursor.ts` | ANSI-based native cursor control for the input box. |
| `src/cli/ink/useMouse.ts` | SGR-encoded mouse input parser + DEC enable/disable. |
| `src/cli/ink/types.ts` | `UiBridge` + `UiEvent` (the agent ↔ UI contract — DO NOT BREAK). |
| `src/cli/ink/InkHook.ts` | `AgentHook` subclass that turns `AgentHookContext` into `UiEvent`s. |
| `src/cli/ink/run.tsx` | `mountApp()` — wraps `App` in `fullscreen-ink`. |
| `src/cli/ink/theme.ts` | Color tokens, layout zones, row-height constants. |
| `src/cli/main.ts` | `cmdAgent` — owns `UiBridge`, mounts/unmounts the app, routes slash commands. |

## Split-state model

The reducer is split into three independent slices:

- `TranscriptSlice` — finalized items. Mutated by `assistant-end`, `tool-end`,
  `notice`, `replay`, `clear`, and the `submit-user` action. Each finalized
  item carries a monotonic numeric id used as a React key.
- `LiveSlice` — streaming assistant text, running tools, busy flag/label.
  Mutated by `assistant-delta`, `tool-start`, `tool-end`, `busy`, `notice`
  (clears are funneled through `applyUiEvent`).
- `UiSlice` — input box, cursor position, history index, autocomplete index,
  dismissal memory. Mutated by `useInput` handlers; never touches the other
  two slices.

Because the slices live in separate reducers, typing into the input box does
not re-render the transcript, and an incoming assistant delta does not
invalidate the input cursor.

## Virtualization

`WindowedList` measures each item via ink's `measureElement` and only renders
items whose position is within `[firstVisible - overscan, lastVisible +
overscan]`. Off-screen items become empty `<Box height={N} />` spacers, so the
scroll math stays correct.

The ref API mimics `ink-scroll-view`'s `ScrollViewRef`:

- `scrollBy(delta)`
- `scrollTo(offset)`
- `scrollToTop()` / `scrollToBottom()`
- `getScrollOffset()` / `getContentHeight()` / `getViewportHeight()`
- `getBottomOffset()` — what auto-scroll jumps to.
- `remeasure()` — call on terminal resize.

Long sessions (500+ items) stay snappy because only ~10 items are mounted at
any time, regardless of transcript length.

## Auto-scroll override (`#8-modul`)

`App` keeps a `followBottom` flag. It starts `true` and is set to `false` the
first time the user presses `PageUp` or scrolls the mouse wheel up. Once
`false`, the auto-scroll `useEffect` short-circuits and the user stays where
they are even while the model streams new tokens.

Pressing `PageDown` while near the bottom re-engages auto-scroll. `Ctrl+End`
is reserved for an explicit "follow again" gesture (UI hook only — see the
follow-up roadmap).

## Markdown caching

Finalized assistant items pass through `cachedMarkdown(id, text)` which
memoizes the parsed ANSI output keyed by `${id}:${hash(text)}`. The cache is
bounded to 2,048 entries so a long session does not leak memory; on overflow
it is wiped clean (cheap because markdown is amortized by item count).

## Native terminal cursor (`useTerminalCursor`)

`useTerminalCursor` paints the OS cursor at the exact cell where the painted
glyph in the input box sits, eliminating the dual-cursor glitch of the old
inverse-text approach. It emits the standard DEC sequences:

- `\x1b[?25l` — hide OS cursor on mount.
- `\x1b[?12l` — disable OS blink (we paint our own).
- `\x1b[{row};{col}H` — CUP to position.
- `\x1b]12;#<hex>\x07` — OSC 12 to color (iTerm2, kitty, wezterm).

If `disabled` is `true` the hook is a no-op so the spinner / busy state can
co-exist with the OS cursor.

## Mouse support (`useMouse`)

`useMouse` enables DEC modes 1000/1002/1006 (button press/release + motion
while held + SGR encoding) on mount and parses the events into a typed
callback. Wheel events use button codes 64/65.

The hook is opt-out via `TARANTUL_NO_MOUSE=1` (or by passing `enabled: false`)
to avoid breaking focus on terminals that don't fully implement the mouse
protocols.

## Slash-command palette

`CommandPalette` replaces the autocomplete-only dropdown. Open with
`Ctrl+/` from the idle state. It includes a live filter, full keyboard
navigation, and a `reducePalette` pure helper for the parent reducer.

## Public contract — what MUST NOT break

| Symbol | Why |
| --- | --- |
| `UiBridge` / `UiEvent` (types.ts) | Used by `InkHook`, which is the only path the agent loop uses to reach the UI. |
| `AppProps` (App.tsx) | Public surface used by `mountApp` callers in `main.ts`. New props must be optional with sensible defaults. |
| `InkHook` (InkHook.ts) | Imported by `main.ts` directly — its `didStream` flag is read by `runTurnInk`. |

## Performance notes

- Streaming re-render storm is bounded by the 50 ms auto-scroll throttle +
  `React.memo` on every Item.
- Markdown parse is cached (O(1) on re-render).
- WindowedList keeps the React subtree flat regardless of transcript length.
- Mouse mode adds a single `process.stdin.on('data')` listener; off-screen
  items do not subscribe.

## Testing

The Ink components themselves are not rendered in unit tests (no JSDOM /
ink-testing-library in the dev deps); instead we test the pure parts:

- `tests/state.test.ts` — split-state helpers + UiEvent application.
- `tests/windowed-list.test.ts` — visibleRange math.
- `tests/use-mouse.test.ts` — SGR mouse payload decoder.
- `tests/use-terminal-cursor.test.ts` — ANSI escape sequences emitted by the cursor hook.

Visual regressions are covered by running `bun run start agent` in a real
terminal.