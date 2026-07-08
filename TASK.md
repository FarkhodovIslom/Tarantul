# TASK: `/settings` command — interactive runtime configuration

**Status: implemented.** This file is the as-built record of the `/settings`
command: an arrow-key menu (Up/Down to move, Enter to select, Esc to
go back/cancel) in the interactive REPL for viewing and changing runtime
configuration (model, provider API keys, generation params), inspecting
skills, and checking usage — with changes **applied live** (persisted to
`~/.tarantul/config.json` and reflected in the running process without a
restart).

## Decisions (locked)

- **UX**: arrow-key selectable menu (Up/Down/j/k to move, Enter to confirm, Esc to
  cancel/back-out), REPL/TTY only. Superseded an earlier numbered-menu design once
  the user asked for real arrow-key + Enter/Esc navigation instead of typed digits.
- **Apply scope**: live. Persist to the config file *and* mutate the in-memory
  `cfg` so the next turn uses the new value. Provider-affecting changes (API key,
  provider selection, sometimes model) rebuild the provider + runner in place.
- Secure fields (API keys) are masked on screen (`•`) and never touch the CLI
  history file — a byproduct of owning raw keypress input instead of `readline`.

## Why it's non-trivial (constraints)

1. Command handlers get a `CommandContext` (`msg, session, key, raw, args, loop`) and
   **no access to `cfg` / `provider`**. In the REPL, `loop` is `null`. So the menu
   cannot be a normal router handler returning a single message — it must be
   special-cased in the REPL loop where `cfg` and `provider` are in scope.
2. `cmdAgent` captures `cfg` in closures; `runTurn` reads `cfg.agents.defaults.model`
   (etc.) **live** each turn. Config changes must **mutate `cfg` in place** — never
   replace the object, or the closures keep the stale reference. `SettingsController`
   only ever reassigns the specific leaf touched (via `setValue`'s `walkToParent`
   helper), so sibling objects like `cfg.agents.defaults` keep their identity too.
3. `provider` is created **once** (`createProvider(cfg)`) and `AgentRunner` stores it
   as a `readonly` field. Live API-key/provider changes require rebuilding both:
   `provider`/`runner` are `let` in `cmdAgent`, reassigned from
   `SettingsController`'s `onProviderChange` hook; `runTurn` reads them from the
   outer binding so reassignment takes effect next turn.
4. **Arrow-key input can't be built on `readline.question()`** — it needs raw,
   per-keystroke events. But the REPL already owns a `readline.Interface` on the
   same stdin. Verified empirically (see `keyboard.ts` doc comment) that:
   - `readline.Interface` with `terminal: true` puts stdin in raw mode for its
     entire lifetime (not just mid-`question()`).
   - `rl.pause()` does **not** detach the Interface's own internal keypress
     decoder — it only stops the stream from flowing. Forcibly resuming the
     stream while paused delivers keystrokes to *both* the Interface's internal
     buffer and a custom listener, corrupting state (observed: a stray
     keystroke silently prepended into the next `question()`'s answer).
   - The reliable fix is **`rl.close()`, not `rl.pause()`** — fully close the
     Interface before taking raw control, then construct a fresh one afterward.
     `Repl.suspend()`/`Repl.restore()` do exactly this.
   - Ctrl-C during raw mode does *not* reliably reach JS as a `SIGINT` process
     signal in the immediate window after enabling raw mode (there's a small
     race where the OS can still deliver it as a real signal); once raw mode is
     established it arrives as a normal keypress (`ctrl: true, name: "c"`).
     `keyboard.ts` handles both: a `process.once("SIGINT", …)` fallback for the
     race window, and explicit `ctrl+c` detection in each keypress handler —
     both hard-exit the process, matching the REPL's existing Ctrl-C-quits
     convention at the main chat prompt.
5. The REPL is single-threaded — while the menu owns stdin, no agent turn runs,
   so there is no race with `runTurn`/session writes.

## Files (as built)

### 1. `src/config/settings.ts` — `SettingsController`
Surface-agnostic config logic (UI-independent; reusable by channels/API later).

- Constructor: `(cfg: Config, configPath: string, hooks: { onProviderChange?: () => void })`.
  Holds the **live** `cfg` reference and mutates it in place.
- Reads: `overview()`, `providerList()` (from the `PROVIDERS` registry, with
  `hasKey`/`isOauth`/`isLocal`), `getValue(dottedPath)`.
- Focused setters: `setModel`, `setProvider`, `setApiKey`, `setTemperature` (0–2),
  `setMaxTokens`/`setContextWindow`/`setMaxToolIterations` (positive ints),
  `setReasoningEffort`. Each validates → mutates in place → persists via
  `saveConfig` → fires `onProviderChange` only when it actually could change
  provider resolution.
- Generic advanced setter: `setValue(path, rawString)` — clones `cfg`, coerces the
  leaf to the existing value's type, re-validates the *whole clone* against
  `ConfigSchema`, and on success writes only that one leaf back onto the live
  `cfg` (via `walkToParent`) before persisting.
- `maskKey()` helper: `sk-a…test` / `(not set)`.

### 2. `src/cli/keyboard.ts` — raw-keypress primitives (new)
- `beginKeyboardSession()` / `endKeyboardSession()`: enable/disable raw + flowing
  stdin for the life of a `/settings` invocation; install/remove the SIGINT
  fallback.
- `selectMenu(options, opts?)`: renders a list, highlights the current item,
  Up/Down/j/k to move (wraps), Enter resolves the index, Esc resolves `null`.
  Redraws in place via cursor-up + line-clear escapes — doesn't touch scrollback
  above it.
- `promptText(question, opts?)`: char-by-char free-text entry with Backspace,
  Enter to confirm, Esc to cancel (`null`). `{ secure: true }` masks each
  typed character with `•` instead of echoing it.
- Both accept an injectable `io: KeyboardIO` (`{ input: KeypressSource; output:
  OutputSink }`, minimal `on`/`removeListener`/`write` shape) defaulting to
  `process.stdin`/`process.stdout`, so tests can drive them with a fake emitter
  instead of a real TTY.

### 3. `src/cli/settings-menu.ts` — `runSettingsMenu(opts)`
`opts: { controller, skillsLoader, getSession, io? }`. Wraps the whole run in
`beginKeyboardSession()`/`endKeyboardSession()`, then loops `selectMenu` over
the top-level options (Model / Provider·API keys / Generation / Skills / Usage /
Advanced / Back to chat), each re-read from `controller.overview()` so the menu
always shows current values. Esc or "Back to chat" exits the loop.

- **Model**: `promptText` → `setModel`.
- **Provider / API keys**: submenu (`selectMenu`) for "Set an API key" vs. "Set
  provider routing"; the former drills into `providerList()` via another
  `selectMenu`, then a **secure** `promptText` for the key.
- **Generation**: `selectMenu` over temperature/max tokens/context window/tool
  iterations/reasoning effort; each numeric one prompts via `promptText` +
  `Number()` parsing, reasoning effort via a `selectMenu` of `low/medium/high/none`.
- **Skills**: read-only dump of `skillsLoader.listSkills(false)` with
  available/always-loaded flags — no extra prompt, falls straight back to the
  top loop.
- **Usage**: read-only `formatUsageSummary(getSessionUsage(getSession()))`.
- **Advanced**: `promptText` for a dotted path, shows `controller.getValue()`,
  `promptText` for the new value, `controller.setValue()`.

### 4. `src/cli/repl.ts` (edited)
- Interface construction factored into a private `createInterface()`.
- Added `suspend()` (`rl.close(); rl = null`) and `restore()`
  (`createInterface()` again, reseeding CLI history) so `/settings` can take
  exclusive raw control of stdin and hand it back cleanly.

### 5. `src/cli/main.ts` (edited, `cmdAgent`)
- `provider`/`runner` are `let`, not `const`.
- `SettingsController` built with `onProviderChange: () => { provider =
  createProvider(cfg); runner = new AgentRunner(provider); }`.
- REPL loop intercepts `/settings` and `/config` before the `CommandRouter`:
  `repl.suspend()` → `await runSettingsMenu(...)` → `repl.restore()` (in a
  `finally`).

### 6. `src/command/builtin.ts` (edited)
- `/settings` listed in `buildHelpText()`.

### 7. `tests/settings.test.ts`
- `SettingsController`: persistence-and-reload, validation rejection paths,
  `onProviderChange` firing rules, `maskKey`, `providerList`. (18 tests)
- `runSettingsMenu`: driven by a `scriptedKeyboardIO(steps)` test helper — a fake
  `KeyboardIO` whose `on("keypress", …)` calls consume one scripted key-sequence
  per prompt shown (arrows/Enter/Esc/chars), asynchronously replayed via
  `queueMicrotask`. Covers: Esc-exits-immediately, model set via default-highlight
  + Enter, API key set via the provider submenu (asserting the typed secret never
  appears in captured output, only `•`), generation params, skills/usage
  consuming zero extra prompts, and the advanced get/set path. (6 tests)

## Verification performed

- `bun run typecheck` clean (strict: `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`).
- `bun run lint`: zero findings in any file this task touched (repo-wide lint has
  pre-existing unrelated failures elsewhere).
- `bun test`: 380/380 passing, including the 24 in `tests/settings.test.ts`.
- Manual end-to-end smoke tests via `expect` driving a real pty (piped stdin
  bypasses the REPL's interactive branch entirely, so this was necessary, not
  optional): confirmed arrow-key top-menu rendering and live redraw, Enter
  selecting "Model" and free-text entry with live per-keystroke redraw, the
  change persisting to `config.json` and reflecting immediately in the next
  menu render, Down-arrow moving the highlight into "Provider / API keys",
  drilling into the provider list (correct `key set`/`no key` and
  `[oauth]`/`[local]` badges), and secure key entry rendering only `•` on
  screen while still applying the real value — followed by Esc returning
  cleanly to the chat prompt.

## Explicit non-goals (v1)

- Enable/disable individual skills, or edit MCP servers, from the menu (read-only
  skills list).
- The menu itself over async channels (Telegram/Slack/Discord) or piped/one-shot
  invocations — `/settings` there would need a separate non-interactive path
  (e.g. a read-only text overview via the `CommandRouter`), not built here.
