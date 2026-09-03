import { useEffect } from "react";

/**
 * Mouse input hook for the Ink TUI.
 *
 * Enables mouse reporting on the controlling terminal and parses SGR-encoded
 * events into a typed callback. Modern terminals (xterm, iTerm2, kitty,
 * wezterm, Alacritty, recent gnome-terminal, Windows Terminal) emit SGR by
 * default once the appropriate modes are enabled.
 *
 * Modes enabled (and the disabled on unmount):
 *   - `\x1b[?1000h` — report button presses + releases
 *   - `\x1b[?1002h` — report button presses/releases + motion while held
 *   - `\x1b[?1006h` — SGR-encoded mouse (vs the legacy VT200-style)
 *   - `\x1b[?1015h` — urxvt-style extended coordinates (some terminals only)
 *
 * The hook does not consume stdin — it listens on the underlying Readable
 * stream that Ink exposes via `useStdin`. When stdin is unavailable (piped
 * mode, CI), it is a no-op.
 *
 * SGR payload: `\x1b[<{button};{x};{y}{M|m}` — capital `M` is press/motion,
 * lowercase `m` is release. Button codes (low 2 bits):
 *   0 = left, 1 = middle, 2 = right, 3 = release (none).
 *   Modifier bits (high bits) encode Shift (4), Alt (8), Ctrl (16).
 *   Special codes 64/65 = wheel up/down, 66/67 = wheel left/right.
 */
export interface MouseEvent {
  /** 1-based column. */
  x: number;
  /** 1-based row. */
  y: number;
  /** Decoded button. */
  button: "left" | "right" | "middle" | "wheel_up" | "wheel_down" | "wheel_left" | "wheel_right";
  /** Whether the event is a press/motion (true) or a release (false). */
  pressed: boolean;
  /** Modifier flags. */
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface UseMouseOptions {
  /** Disable the hook (e.g. on non-TTY or after a config opt-out). */
  enabled?: boolean;
  /** Ignore motion events — only emit press/release + wheel. Default true. */
  ignoreMotion?: boolean;
}

const ESC = "\x1b";
const ENABLE = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`;
const DISABLE = `${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l`;

/** SGR mouse payload: `\x1b[<CB;X;YM` or `\x1b[<CB;X;Ym`. */
const SGR_PATTERN = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

function buttonType(code: number): MouseEvent["button"] | null {
  // Wheel events have the high bit set (codes 64+).
  if (code === 64) return "wheel_up";
  if (code === 65) return "wheel_down";
  if (code === 66) return "wheel_left";
  if (code === 67) return "wheel_right";
  // Press: 0=left, 1=middle, 2=right, 3=release-of-none (rare).
  const base = code & 0b11;
  if (base === 0) return "left";
  if (base === 1) return "middle";
  if (base === 2) return "right";
  return null;
}

/** Subscribe to mouse events from the controlling terminal. */
export function useMouse(handler: (event: MouseEvent) => void, opts: UseMouseOptions = {}): void {
  const { enabled = true, ignoreMotion = true } = opts;

  useEffect(() => {
    if (!enabled) return;
    if (!process.stdin.isTTY) return;

    process.stdout.write(ENABLE);

    const onData = (buf: Buffer | string): void => {
      const text = typeof buf === "string" ? buf : buf.toString("utf8");
      let match: RegExpExecArray | null;
      // Reset state for each chunk — the global regex carries `lastIndex` between calls.
      SGR_PATTERN.lastIndex = 0;
      while ((match = SGR_PATTERN.exec(text)) !== null) {
        const code = Number(match[1]);
        const x = Number(match[2]);
        const y = Number(match[3]);
        const pressed = match[4] === "M";
        const button = buttonType(code);
        if (!button) continue;
        if (ignoreMotion && !pressed && button !== "wheel_up" && button !== "wheel_down") {
          // Suppress motion/release events for normal buttons.
          continue;
        }
        handler({
          x,
          y,
          button,
          pressed,
          shift: (code & 4) !== 0,
          alt: (code & 8) !== 0,
          ctrl: (code & 16) !== 0,
        });
      }
    };

    process.stdin.on("data", onData);
    return () => {
      process.stdin.off("data", onData);
      process.stdout.write(DISABLE);
    };
  }, [enabled, handler, ignoreMotion]);
}
