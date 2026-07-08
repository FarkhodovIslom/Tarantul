
/**
 * Raw-keypress input primitives for the `/settings` arrow-key menu.
 *
 * Requires exclusive control of stdin: a live `readline.Interface` on the
 * same stream decodes keypresses itself, and letting both consume the
 * stream at once corrupts input (verified empirically — a paused Interface
 * still buffers keystrokes internally even while a second listener reads
 * the same stream). Callers must fully close their `readline.Interface`
 * first (see `Repl.suspend()`/`Repl.restore()` in `repl.ts`) and only
 * recreate it after `endKeyboardSession()`.
 *
 * `process.stdin` already has `readline.emitKeypressEvents()` wired up for
 * the life of the process once any `readline.Interface` has existed on it
 * (true throughout the REPL), so a session only needs to (re)enable raw
 * mode and put the stream back in flowing mode.
 */

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
  if (process.stdin.isTTY && !process.stdin.isRaw) process.stdin.setRawMode(true);
  process.stdin.resume();
  // Defensive fallback for the brief window before raw mode fully takes
  // effect, where Ctrl-C can still reach the OS as a real SIGINT.
  sigintFallback = () => hardExit(defaultIO());
  process.once("SIGINT", sigintFallback);
}

/** Stop the flowing stream; the caller hands stdin back to a fresh readline.Interface next. */
export function endKeyboardSession(): void {
  process.stdin.pause();
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
export function selectMenu(options: SelectOption[], opts: SelectMenuOpts = {}): Promise<number | null> {
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
