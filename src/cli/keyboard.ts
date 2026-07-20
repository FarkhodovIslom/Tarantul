/**
 * Raw-keypress input primitives for the `/settings` arrow-key menu.
 *
 * Requires exclusive control of stdin: any other consumer decoding
 * keypresses on the same stream at once corrupts input (verified
 * empirically — a "paused" `readline.Interface` still buffers keystrokes
 * internally even while a second listener reads the same stream, and Ink's
 * `<App>` sets up its own keypress listener + raw mode for as long as it's
 * mounted). Callers must fully release stdin first — close a
 * `readline.Interface` or `unmount()` the Ink instance — and only resume it
 * after `endKeyboardSession()` (see the `/settings` handling in `main.ts`,
 * which unmounts Ink before this session and remounts a fresh instance
 * after).
 *
 * `beginKeyboardSession()` wires up `readline.emitKeypressEvents()` itself —
 * it's what makes `process.stdin` emit the `"keypress"` events this module
 * listens for. Ink does not use that event (it parses raw input itself), so
 * nothing else in the app can be relied on to have wired it up first.
 *
 * Note: this module does not keep the process alive on its own — see the
 * dedicated keep-alive interval around the whole interactive REPL section in
 * `main.ts`, which covers the gap Ink's own stdin.unref()-on-unmount would
 * otherwise leave between a `/settings` session and the next Ink mount.
 */

import { emitKeypressEvents } from "node:readline";
import { styled, ansi } from "./render.js";

export interface KeyEvent {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export interface KeypressSource {
  on(event: "keypress", listener: (str: string, key: KeyEvent) => void): unknown;
  removeListener(event: "keypress", listener: (str: string, key: KeyEvent) => void): unknown;
}

export interface OutputSink {
  write(chunk: string): unknown;
}

export interface KeyboardIO {
  input: KeypressSource;
  output: OutputSink;
}

const defaultIO = (): KeyboardIO => ({ input: process.stdin, output: process.stdout });

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

let sigintFallback: (() => void) | null = null;

/** Enable raw, flowing keypress mode. Call once before a run of prompts. */
export function beginKeyboardSession(): void {
  // Idempotent: Node tracks whether a stream already has a keypress decoder
  // attached, so calling this on every session (rather than trusting some
  // other part of the app to have called it once) is cheap and safe.
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY && !process.stdin.isRaw) process.stdin.setRawMode(true);
  process.stdin.resume();
  // Defensive fallback for the brief window before raw mode fully takes
  // effect, where Ctrl-C can still reach the OS as a real SIGINT.
  sigintFallback = () => hardExit(defaultIO());
  process.once("SIGINT", sigintFallback);
}

/**
 * Stop the flowing stream and hand stdin back in as close to its pristine
 * state as possible — the caller mounts a fresh Ink instance next.
 *
 * `emitKeypressEvents()` (in {@link beginKeyboardSession}) attaches a 'data'
 * listener with no public way to detach it, which leaves the stream latched
 * into flowing mode; Ink's own input handling expects to manage that mode
 * itself via 'readable' + `read()`, and the two don't coexist — with the
 * stray 'data' listener still attached, the *next* Ink instance renders but
 * never receives another keystroke (verified empirically). Dropping both
 * listener kinds and turning raw mode off lets Ink's mount effect set it
 * all up again from a clean slate, exactly like a first mount.
 */
export function endKeyboardSession(): void {
  process.stdin.pause();
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("readable");
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  if (sigintFallback) {
    process.removeListener("SIGINT", sigintFallback);
    sigintFallback = null;
  }
}

function isCtrlC(key: KeyEvent | undefined): boolean {
  return Boolean(key?.ctrl && key.name === "c");
}

/** Ctrl-C during the menu exits the whole app, matching the REPL's own default SIGINT behavior. */
function hardExit(io: KeyboardIO): never {
  io.output.write("\n");
  process.exit(130);
}

// ---------------------------------------------------------------------------
// selectMenu — arrow-key list selection
// ---------------------------------------------------------------------------

export interface SelectOption {
  label: string;
  hint?: string;
}

export interface SelectMenuOpts {
  initial?: number;
  io?: KeyboardIO | undefined;
}

/**
 * Render `options`, move the highlight with Up/Down or j/k (wrapping),
 * confirm with Enter, cancel with Esc. Resolves the chosen index, or `null`
 * on Esc. Ctrl-C exits the process.
 */
export function selectMenu(
  options: SelectOption[],
  opts: SelectMenuOpts = {},
): Promise<number | null> {
  const io = opts.io ?? defaultIO();
  return new Promise((resolve) => {
    let index = Math.min(Math.max(opts.initial ?? 0, 0), Math.max(options.length - 1, 0));
    let drawn = false;

    const lineFor = (o: SelectOption, i: number): string => {
      const marker = i === index ? styled("❯", ansi.cyan) : " ";
      const label = i === index ? styled(o.label, ansi.cyan, ansi.bold) : o.label;
      const hint = o.hint ? styled(`  ${o.hint}`, ansi.dim) : "";
      return `${marker} ${label}${hint}`;
    };

    const render = (): void => {
      if (drawn) io.output.write(`\x1b[${options.length}A`);
      for (const line of options.map(lineFor)) io.output.write(`\x1b[2K${line}\n`);
      drawn = true;
    };

    const cleanup = (): void => {
      io.input.removeListener("keypress", onKeypress);
    };

    const onKeypress = (_str: string, key: KeyEvent): void => {
      if (isCtrlC(key)) {
        cleanup();
        hardExit(io);
      }
      switch (key.name) {
        case "escape":
          cleanup();
          resolve(null);
          return;
        case "return":
        case "enter":
          cleanup();
          resolve(index);
          return;
        case "up":
        case "k":
          index = (index - 1 + options.length) % options.length;
          render();
          return;
        case "down":
        case "j":
          index = (index + 1) % options.length;
          render();
          return;
        default:
          return;
      }
    };

    io.input.on("keypress", onKeypress);
    render();
  });
}

// ---------------------------------------------------------------------------
// promptText — free-text line entry with Esc-to-cancel
// ---------------------------------------------------------------------------

export interface PromptTextOpts {
  /** Mask typed characters with •, and never surface the value anywhere but the resolved string. */
  secure?: boolean;
  io?: KeyboardIO | undefined;
}

/**
 * Read one line of free text char-by-char. Enter confirms, Esc cancels
 * (resolves `null`), Backspace edits. With `secure: true`, typed characters
 * are masked on screen — this also means secrets typed here never touch the
 * CLI history file, unlike the readline-based chat prompt.
 */
export function promptText(question: string, opts: PromptTextOpts = {}): Promise<string | null> {
  const io = opts.io ?? defaultIO();
  return new Promise((resolve) => {
    let buf = "";
    let drawn = false;

    const render = (): void => {
      if (drawn) io.output.write("\x1b[1A");
      const shown = opts.secure ? "•".repeat(buf.length) : buf;
      io.output.write(`\x1b[2K${styled("> ", ansi.dim)}${shown}\n`);
      drawn = true;
    };

    const cleanup = (): void => {
      io.input.removeListener("keypress", onKeypress);
    };

    const onKeypress = (str: string, key: KeyEvent): void => {
      if (isCtrlC(key)) {
        cleanup();
        hardExit(io);
      }
      switch (key.name) {
        case "escape":
          cleanup();
          resolve(null);
          return;
        case "return":
        case "enter":
          cleanup();
          resolve(buf);
          return;
        case "backspace":
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            render();
          }
          return;
        default:
          if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") {
            buf += str;
            render();
          }
      }
    };

    io.output.write(`${styled(question, ansi.dim)}\n`);
    io.input.on("keypress", onKeypress);
    render();
  });
}
