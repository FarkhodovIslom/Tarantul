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
// Streaming markdown renderer
// Minimal subset: bold, code spans, headings, bullet lists.
// ---------------------------------------------------------------------------

const LOGO = "🐈";
const BOT_NAME = "nanobot";

/**
 * Lightweight Markdown → ANSI converter for terminal display.
 * Only the most common patterns; avoids pulling in a full parser.
 */
export function markdownToAnsi(text: string): string {
  if (!isColorSupported()) return text;

  const lines = text.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    let l = line;

    // Headings  ## Title
    const heading = l.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      out.push(styled(heading[2]!, ansi.bold, ansi.cyan));
      continue;
    }

    // Bullet lists
    const bullet = l.match(/^(\s*)([-*])\s+(.*)$/);
    if (bullet) {
      const processed = inlineMarkdown(bullet[3]!);
      out.push(`${bullet[1]}• ${processed}`);
      continue;
    }

    // Code block fence — pass through as-is (dimmed)
    if (l.startsWith("```")) {
      out.push(styled(l, ansi.dim));
      continue;
    }

    out.push(inlineMarkdown(l));
  }

  return out.join("\n");
}

function inlineMarkdown(text: string): string {
  if (!isColorSupported()) return text;
  return text
    // **bold**
    .replace(/\*\*(.+?)\*\*/g, (_, m: string) => styled(m, ansi.bold))
    // `code`
    .replace(/`([^`]+)`/g, (_, m: string) => styled(m, ansi.dim))
    // *italic*
    .replace(/\*(.+?)\*/g, (_, m: string) => styled(m, ansi.dim));
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
  private buf = "";
  private started = false;
  private readonly spinner: Spinner;
  streamed = false;

  constructor(private readonly renderMarkdown: boolean) {
    this.spinner = new Spinner();
    this.spinner.start();
  }

  async onDelta(delta: string): Promise<void> {
    this.streamed = true;
    this.buf += delta;

    if (!this.started && this.buf.trim()) {
      this.spinner.stop();
      process.stdout.write("\n" + styled(`${LOGO} ${BOT_NAME}`, ansi.cyan) + "\n");
      this.started = true;
    }

    if (this.started) {
      // Write incremental delta — note this is raw text during streaming
      printDelta(delta);
    }
  }

  async onEnd(opts: { resuming: boolean }): Promise<void> {
    this.spinner.stop();

    if (this.started) {
      // Render final accumulated content with markdown if enabled
      if (this.renderMarkdown && this.buf.trim()) {
        // Move up and re-render the full content with ANSI styling
        // For simplicity, just add newlines to close out the stream
        process.stdout.write("\n");
      } else {
        process.stdout.write("\n");
      }
    }

    if (opts.resuming) {
      this.buf = "";
      this.started = false;
      this.spinner.start();
    } else {
      process.stdout.write("\n");
    }
  }

  async close(): Promise<void> {
    this.spinner.stop();
  }
}
