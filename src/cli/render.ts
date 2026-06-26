/**
 * Terminal rendering utilities — ANSI-only, no external deps.
 * Replaces rich/markdown in the Python CLI.
 */

// ---------------------------------------------------------------------------
// ANSI escape helpers
// ---------------------------------------------------------------------------

const ESC = "\x1b[";

export const ansi = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  strike: `${ESC}9m`,
  cyan: `${ESC}36m`,
  yellow: `${ESC}33m`,
  green: `${ESC}32m`,
  red: `${ESC}31m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,
};

export function styled(text: string, ...codes: string[]): string {
  if (!isColorSupported()) return text;
  return codes.join("") + text + ansi.reset;
}

export function isColorSupported(): boolean {
  if (process.env["NO_COLOR"]) return false;
  if (process.env["FORCE_COLOR"]) return true;
  return process.stdout.isTTY === true;
}

// ---------------------------------------------------------------------------
// Markdown → ANSI renderer
// Block-aware (headings, lists, blockquotes, code fences, rules) with inline
// emphasis. Stateful across lines so fenced code blocks survive line-by-line
// streaming. Lightweight — no external parser.
// ---------------------------------------------------------------------------

const LOGO = "🕷️";
const BOT_NAME = "tarantul";

const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Stateful line-oriented Markdown renderer. Feed it one source line at a time
 * (without the trailing newline) via {@link renderLine}; it tracks fenced code
 * block state so the same instance can render a whole document or a stream.
 */
export class MarkdownRenderer {
  private inFence = false;

  /** Render a single source line to ANSI. Returns the line unchanged when color is off. */
  renderLine(src: string): string {
    if (!isColorSupported()) return src;

    // Fenced code block delimiters toggle the fenced state either way.
    if (FENCE_RE.test(src)) {
      this.inFence = !this.inFence;
      return styled(src, ansi.gray);
    }
    if (this.inFence) return styled(src, ansi.gray);

    return renderBlockLine(src);
  }
}

/**
 * Lightweight Markdown → ANSI converter for a complete string.
 * Convenience wrapper over {@link MarkdownRenderer} for non-streaming output.
 */
export function markdownToAnsi(text: string): string {
  if (!isColorSupported()) return text;
  const r = new MarkdownRenderer();
  return text
    .split("\n")
    .map((line) => r.renderLine(line))
    .join("\n");
}

/** Render a single non-fenced line: headings, lists, quotes, rules, or inline. */
function renderBlockLine(l: string): string {
  // Headings  # .. ###### Title
  const heading = l.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const codes =
      heading[1]!.length === 1 ? [ansi.bold, ansi.cyan, ansi.underline] : [ansi.bold, ansi.cyan];
    return styled(inlineMarkdown(heading[2]!), ...codes);
  }

  // Horizontal rule  --- / *** / ___
  if (/^\s*([-*_])\1{2,}\s*$/.test(l)) {
    const width = Math.min(40, process.stdout.columns || 40);
    return styled("─".repeat(width), ansi.gray);
  }

  // Blockquote  > text
  const quote = l.match(/^(\s*)>\s?(.*)$/);
  if (quote) {
    return `${quote[1]}${styled("│ ", ansi.gray)}${styled(inlineMarkdown(quote[2]!), ansi.gray)}`;
  }

  // Ordered list  1. text
  const ordered = l.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (ordered) {
    return `${ordered[1]}${styled(`${ordered[2]}.`, ansi.cyan)} ${inlineMarkdown(ordered[3]!)}`;
  }

  // Bullet list  - / * / + text
  const bullet = l.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) {
    return `${bullet[1]}${styled("•", ansi.cyan)} ${inlineMarkdown(bullet[2]!)}`;
  }

  return inlineMarkdown(l);
}

function inlineMarkdown(text: string): string {
  if (!isColorSupported()) return text;
  return (
    text
      // `code` — render first so its contents are left intact
      .replace(/`([^`]+)`/g, (_, m: string) => styled(m, ansi.yellow))
      // **bold** / __bold__
      .replace(/\*\*(.+?)\*\*/g, (_, m: string) => styled(m, ansi.bold))
      .replace(/__(.+?)__/g, (_, m: string) => styled(m, ansi.bold))
      // ~~strikethrough~~
      .replace(/~~(.+?)~~/g, (_, m: string) => styled(m, ansi.strike))
      // *italic* / _italic_
      .replace(/\*(.+?)\*/g, (_, m: string) => styled(m, ansi.italic))
      .replace(/(?<![\w])_(.+?)_(?![\w])/g, (_, m: string) => styled(m, ansi.italic))
      // [text](url) — last, so URL punctuation isn't reprocessed
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_, label: string, url: string) =>
          `${styled(label, ansi.blue, ansi.underline)}${styled(` (${url})`, ansi.dim)}`,
      )
  );
}

// ---------------------------------------------------------------------------
// Terminal output functions
// ---------------------------------------------------------------------------

/** Print the bot header + response text to stdout. */
export function printResponse(content: string, asMarkdown: boolean, asText = false): void {
  process.stdout.write("\n");
  process.stdout.write(styled(`${LOGO} ${BOT_NAME}`, ansi.cyan) + "\n");
  const rendered = asText || !asMarkdown ? content : markdownToAnsi(content);
  process.stdout.write(rendered + "\n\n");
}

/** Print a dimmed progress / tool hint line. */
export function printProgress(text: string): void {
  process.stdout.write(styled(`  ↳ ${text}`, ansi.dim) + "\n");
}

/** Print a streaming delta in-place (no newline). */
export function printDelta(delta: string): void {
  process.stdout.write(delta);
}

/** Clear current line and move cursor to column 0. */
export function clearLine(): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r${ESC}2K`);
  }
}

/** Simple spinner frames. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  start(message = "thinking..."): void {
    if (!process.stdout.isTTY) return;
    this.active = true;
    this.timer = setInterval(() => {
      const f = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]!;
      process.stdout.write(`\r${styled(f, ansi.cyan)} ${styled(message, ansi.dim)}`);
      this.frame++;
    }, 80);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.active && process.stdout.isTTY) {
      clearLine();
    }
    this.active = false;
    this.frame = 0;
  }

  pause<T>(fn: () => T): T {
    this.stop();
    const result = fn();
    return result;
  }
}

// ---------------------------------------------------------------------------
// StreamRenderer — accumulates stream deltas + manages spinner lifecycle
// ---------------------------------------------------------------------------

export class StreamRenderer {
  /** Holds the in-progress (not yet newline-terminated) line in markdown mode. */
  private pending = "";
  private started = false;
  private readonly spinner: Spinner;
  private readonly md = new MarkdownRenderer();
  /** True when we style output line-by-line; false falls back to raw passthrough. */
  private readonly useMarkdown: boolean;
  streamed = false;

  constructor(renderMarkdown: boolean) {
    this.useMarkdown = renderMarkdown && isColorSupported();
    this.spinner = new Spinner();
    this.spinner.start();
  }

  async onDelta(delta: string): Promise<void> {
    this.streamed = true;
    this.pending += delta;

    // Defer the header until the first non-blank content arrives.
    if (!this.started) {
      if (!this.pending.trim()) return;
      this.spinner.stop();
      process.stdout.write("\n" + styled(`${LOGO} ${BOT_NAME}`, ansi.cyan) + "\n");
      this.started = true;
    }

    if (!this.useMarkdown) {
      // Raw passthrough — token-by-token, no styling.
      process.stdout.write(this.pending);
      this.pending = "";
      return;
    }

    // Markdown mode: flush every complete line, holding the trailing partial.
    let nl = this.pending.indexOf("\n");
    while (nl !== -1) {
      const line = this.pending.slice(0, nl);
      process.stdout.write(this.md.renderLine(line) + "\n");
      this.pending = this.pending.slice(nl + 1);
      nl = this.pending.indexOf("\n");
    }
  }

  async onEnd(opts: { resuming: boolean }): Promise<void> {
    this.spinner.stop();

    if (this.started) {
      // Flush any trailing partial line through the renderer.
      if (this.useMarkdown && this.pending.length > 0) {
        process.stdout.write(this.md.renderLine(this.pending) + "\n");
      } else {
        process.stdout.write("\n");
      }
      this.pending = "";
    }

    if (opts.resuming) {
      this.started = false;
      this.spinner.start();
    } else if (this.started) {
      process.stdout.write("\n");
    }
  }

  async close(): Promise<void> {
    this.spinner.stop();
  }

  /** Stop the underlying spinner without flushing pending content. */
  stopSpinner(): void {
    this.spinner.stop();
  }
}

// ---------------------------------------------------------------------------
// Tool-use status rendering
// Maps a tool name + args to a human label, then renders an in-place
// spinner→checkmark line per tool. No-ops outside a TTY.
// ---------------------------------------------------------------------------

/** Extract a file/dir basename from an arg value of unknown shape. */
function pathBaseName(p: unknown): string {
  if (typeof p !== "string" || p.length === 0) return "";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Truncate a shell command for inline display. */
function truncateCmd(cmd: unknown, max = 48): string {
  if (typeof cmd !== "string") return "";
  const c = cmd.trim().replace(/\s+/g, " ");
  return c.length > max ? `${c.slice(0, max - 1)}…` : c;
}

export interface ToolStatusLabel {
  /** Label shown while the tool is running (with spinner). */
  running: string;
  /** Label shown when the tool finishes (with checkmark). */
  done: string;
}

/**
 * Map a tool name + its call args to a human-readable running/done label pair.
 * Unknown tools fall back to a capitalized form of the name.
 */
export function toolStatusLabel(
  name: string,
  args: Record<string, unknown>,
): ToolStatusLabel {
  const path = pathBaseName(args["path"]);
  const withPath = (verb: string, past: string): ToolStatusLabel => ({
    running: path ? `${verb} ${path}` : verb,
    done: path ? `${past}: ${path}` : past,
  });
  switch (name) {
    case "write_file":
      return withPath("Creating", "File created");
    case "read_file":
      return withPath("Reading", "Read");
    case "edit_file":
      return withPath("Editing", "Edited");
    case "list_dir":
      return withPath("Listing", "Listed");
    case "exec": {
      const c = truncateCmd(args["command"]);
      return {
        running: c ? `Running command: ${c}` : "Running command",
        done: "Command finished",
      };
    }
    case "cron":
      return { running: "Scheduling task", done: "Task scheduled" };
    case "web_search":
      return { running: "Searching the web", done: "Web search done" };
    case "web_fetch":
      return { running: "Fetching URL", done: "Fetched URL" };
    default: {
      const cap = name ? name.charAt(0).toUpperCase() + name.slice(1) : "Tool";
      return { running: cap, done: `${cap} done` };
    }
  }
}

/**
 * Renders a single tool's lifecycle: an animated spinner labelled with the
 * running action, replaced in place by a green ✓ / red ✗ and the done label.
 * All methods are no-ops when stdout is not a TTY.
 */
export class ToolStatusRenderer {
  private readonly spinner = new Spinner();
  private active = false;

  start(label: string): void {
    if (!process.stdout.isTTY) return;
    this.spinner.stop();
    this.spinner.start(`${label}…`);
    this.active = true;
  }

  finish(label: string, ok = true): void {
    if (!process.stdout.isTTY) return;
    this.spinner.stop();
    this.active = false;
    const mark = ok ? styled("✓", ansi.green) : styled("✗", ansi.red);
    process.stdout.write(`${mark} ${styled(label, ansi.dim)}\n`);
  }

  /** Clear any active spinner without printing a result line. */
  stop(): void {
    if (this.active) {
      this.spinner.stop();
      this.active = false;
    }
  }
}
