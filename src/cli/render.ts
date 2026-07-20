
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

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

/**
 * Approximate terminal display width: emoji/CJK/fullwidth code points count
 * as 2 columns, ANSI codes and joiners as 0. Good enough to right-align the
 * banner box borders around the strings we render ourselves.
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f || cp === 0x200d) continue; // variation selector / ZWJ
    const wide =
      cp >= 0x1f000 || // emoji planes
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
      (cp >= 0xff00 && cp <= 0xff60); // fullwidth forms
    w += wide ? 2 : 1;
  }
  return w;
}

// ---------------------------------------------------------------------------
// Dracula theme (truecolor) — accents used by all REPL chrome
// ---------------------------------------------------------------------------

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * True when the terminal understands 24-bit `38;2;r;g;b` sequences. Notably
 * false for macOS Terminal.app, which mangles truecolor into muddy 8-color
 * approximations — there we emit the nearest xterm-256 index instead.
 */
function supportsTruecolor(): boolean {
  if (/truecolor|24bit/i.test(process.env["COLORTERM"] ?? "")) return true;
  const tp = process.env["TERM_PROGRAM"] ?? "";
  if (["iTerm.app", "WezTerm", "ghostty", "vscode", "Hyper", "Tabby"].includes(tp)) return true;
  return /kitty|alacritty|direct/i.test(process.env["TERM"] ?? "");
}

const TRUECOLOR = supportsTruecolor();

/** Quantization levels of the xterm-256 6×6×6 color cube. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** Nearest xterm-256 palette index for an RGB color (cube or grayscale ramp). */
export function nearest256(r: number, g: number, b: number): number {
  const qi = (v: number): number => {
    let best = 0;
    for (let i = 1; i < CUBE_LEVELS.length; i++) {
      if (Math.abs((CUBE_LEVELS[i] ?? 0) - v) < Math.abs((CUBE_LEVELS[best] ?? 0) - v)) best = i;
    }
    return best;
  };
  const ri = qi(r);
  const gi = qi(g);
  const bi = qi(b);
  const cube = [CUBE_LEVELS[ri] ?? 0, CUBE_LEVELS[gi] ?? 0, CUBE_LEVELS[bi] ?? 0] as const;

  // Grayscale ramp: indexes 232-255 cover #080808..#eeeeee in steps of 10.
  const gray = Math.round((r + g + b) / 3);
  const gs = Math.min(23, Math.max(0, Math.round((gray - 8) / 10)));
  const grayVal = 8 + gs * 10;

  const dist = (x: readonly [number, number, number]): number =>
    (x[0] - r) ** 2 + (x[1] - g) ** 2 + (x[2] - b) ** 2;
  return dist(cube) <= dist([grayVal, grayVal, grayVal]) ? 16 + 36 * ri + 6 * gi + bi : 232 + gs;
}

function fgHex(hex: string): string {
  const [r, g, b] = hexRgb(hex);
  return TRUECOLOR ? `${ESC}38;2;${r};${g};${b}m` : `${ESC}38;5;${nearest256(r, g, b)}m`;
}

function bgHex(hex: string): string {
  const [r, g, b] = hexRgb(hex);
  return TRUECOLOR ? `${ESC}48;2;${r};${g};${b}m` : `${ESC}48;5;${nearest256(r, g, b)}m`;
}

/** Dracula palette (https://draculatheme.com/contribute#color-palette). */
export const theme = {
  purple: fgHex("#bd93f9"),
  pink: fgHex("#ff79c6"),
  cyan: fgHex("#8be9fd"),
  green: fgHex("#50fa7b"),
  red: fgHex("#ff5555"),
  orange: fgHex("#ffb86c"),
  yellow: fgHex("#f1fa8c"),
  comment: fgHex("#6272a4"),
  fgMain: fgHex("#f8f8f2"),
  /** Tinted background for the input bar ("current line" in Dracula). */
  inputBg: bgHex("#44475a"),
  /** Subtle panel background for message blocks (Dracula "background"). */
  panelBg: bgHex("#282a36"),
};

/**
 * One full-width line of an opencode-style message panel: colored left
 * border + content on a subtly tinted background. Inline resets inside the
 * rendered content are re-tinted so the panel background never drops out
 * mid-line. Falls back to a plain bordered line when color is off.
 */
export function panelLine(rendered: string, borderColor: string): string {
  if (!isColorSupported()) return `▌ ${rendered}\n`;
  const cols = Math.max(20, process.stdout.columns || 80);
  const bg = theme.panelBg;
  const body = rendered.replaceAll(ansi.reset, `${ansi.reset}${bg}${theme.fgMain}`);
  const pad = Math.max(0, cols - 2 - displayWidth(rendered));
  return `${bg}${borderColor}▌${ansi.reset}${bg}${theme.fgMain} ${body}${" ".repeat(pad)}${ansi.reset}\n`;
}

// ---------------------------------------------------------------------------
// Markdown → ANSI renderer
// Block-aware (headings, lists, blockquotes, code fences, rules) with inline
// emphasis. Stateful across lines so fenced code blocks survive line-by-line
// streaming. Lightweight — no external parser.
// ---------------------------------------------------------------------------

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
      return styled(src, theme.comment);
    }
    if (this.inFence) return styled(src, theme.green);

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
      heading[1]!.length === 1
        ? [ansi.bold, theme.pink, ansi.underline]
        : [ansi.bold, theme.pink];
    return styled(inlineMarkdown(heading[2]!), ...codes);
  }

  // Horizontal rule  --- / *** / ___
  if (/^\s*([-*_])\1{2,}\s*$/.test(l)) {
    const width = Math.min(40, process.stdout.columns || 40);
    return styled("─".repeat(width), theme.comment);
  }

  // Blockquote  > text
  const quote = l.match(/^(\s*)>\s?(.*)$/);
  if (quote) {
    return `${quote[1]}${styled("│ ", theme.comment)}${styled(inlineMarkdown(quote[2]!), theme.comment)}`;
  }

  // Ordered list  1. text
  const ordered = l.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (ordered) {
    return `${ordered[1]}${styled(`${ordered[2]}.`, theme.purple)} ${inlineMarkdown(ordered[3]!)}`;
  }

  // Bullet list  - / * / + text
  const bullet = l.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) {
    return `${bullet[1]}${styled("•", theme.purple)} ${inlineMarkdown(bullet[2]!)}`;
  }

  return inlineMarkdown(l);
}

function inlineMarkdown(text: string): string {
  if (!isColorSupported()) return text;
  return (
    text
      // `code` — render first so its contents are left intact
      .replace(/`([^`]+)`/g, (_, m: string) => styled(m, theme.green))
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
          `${styled(label, theme.cyan, ansi.underline)}${styled(` (${url})`, ansi.dim)}`,
      )
  );
}

// ---------------------------------------------------------------------------
// Terminal output functions — used by non-interactive (one-shot/piped) runs.
// The interactive REPL is an Ink app (see cli/ink/); Ink owns its own
// rendering and reuses markdownToAnsi/toolCallLabel from this module.
// ---------------------------------------------------------------------------

/** Print an assistant response as an accent-bordered tinted panel (opencode-style). */
export function printResponse(content: string, asMarkdown: boolean, asText = false): void {
  const rendered = asText || !asMarkdown ? content : markdownToAnsi(content);
  const block = rendered
    .split("\n")
    .map((l) => panelLine(l, theme.purple))
    .join("");
  process.stdout.write(`\n${block}\n`);
}

/** Print a dimmed progress / tool hint line. */
export function printProgress(text: string): void {
  process.stdout.write(styled(`  ↳ ${text}`, ansi.dim) + "\n");
}

// ---------------------------------------------------------------------------
// Tool call labels — shared by the Ink UI's live tool rows.
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

/**
 * Claude-code style call chip: `name(concise arg)` — the raw tool name plus
 * the one argument that identifies the call (command, path, query, …).
 */
export function toolCallLabel(name: string, args: Record<string, unknown>): string {
  const arg = ((): string => {
    switch (name) {
      case "exec":
        return truncateCmd(args["command"]);
      case "read_file":
      case "write_file":
      case "edit_file":
      case "list_dir":
        return pathBaseName(args["path"]);
      case "web_search":
      case "memory_search":
        return truncateCmd(args["query"], 40);
      case "web_fetch":
        return truncateCmd(args["url"], 40);
      case "memory_get":
        return pathBaseName(args["path"]);
      case "memory_write":
        return truncateCmd(args["target"], 40);
      case "memory_links":
        return truncateCmd(args["note"], 40);
      default:
        return "";
    }
  })();
  return arg ? `${name}(${arg})` : name;
}
