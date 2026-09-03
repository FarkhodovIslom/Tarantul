import { useEffect } from "react";

/**
 * Native terminal cursor for the input box.
 *
 * The default `InputBar` paints a fake cursor via `<Text inverse>{char}</Text>`,
 * which means the real OS cursor is still visible underneath and the user sees
 * two cursors blinking out of sync. This hook hides the OS cursor while the
 * input is focused and renders the application cursor at the right cell by
 * emitting ANSI escape sequences.
 *
 * Strategy:
 *   - Hide the OS cursor on mount (`\x1b[?25l`) and reveal it on unmount
 *     (`\x1b[?25h`).
 *   - Disable the OS blink (`\x1b[?12l`) — we paint our own blink via the
 *     inverse-text cursor in `InputBar` — and restore it on unmount.
 *   - On cursor-row changes (the row where the input box sits inside the
 *     viewport), emit `\x1b[{row};{col}H` to position the OS cursor precisely
 *     over the painted glyph. On row changes we also re-hide it so the OS
 *     cursor doesn't reappear between paints.
 *   - If `disabled` is true, leave the OS cursor visible and let Ink render
 *     the input as static text.
 *
 * The hook only emits writes to `process.stdout`; it never reads or polls
 * stdin, so it composes cleanly with `useInput`.
 */
export interface UseTerminalCursorOptions {
  /** Current input value. */
  value: string;
  /** Cursor offset (0-based, measured in JS characters — for graphemes we
   *  fall back to JS length; this is good enough for the input box). */
  cursor: number;
  /**
   * Terminal row (1-based, ANSI CUP convention) where the input box starts.
   * Defaults to `Infinity`, which means "do not position the OS cursor".
   */
  inputRow?: number;
  /**
   * Column inside the input box where the cursor should sit. The hook adds
   * 1 for the leading "✦ " glyph and 1 for paddingX (passed in by the caller).
   */
  col?: number;
  /** When true, leave the OS cursor visible — useful while the input is busy. */
  disabled?: boolean;
  /** Set the cursor color via OSC 12 (modern terminals like iTerm2, kitty, wezterm). */
  color?: string;
}

const ESC = "\x1b";

/** Hide the OS cursor (DEC) and disable the blink cursor (DEC). */
const HIDE_CURSOR = `${ESC}[?25l${ESC}[?12l`;
/** Reveal the OS cursor and restore the default blink cursor behavior. */
const SHOW_CURSOR = `${ESC}[?25h${ESC}[?12l`;
/** Position the OS cursor at row, col. */
const CURSOR_POSITION = (row: number, col: number): string => `${ESC}[${row};${col}H`;
/** Set the OS cursor color via OSC 12. */
const SET_CURSOR_COLOR = (hex: string): string => `${ESC}]12;#${hex.replace(/^#/, "")}\x07`;
/** Reset the OS cursor color to default. */
const RESET_CURSOR_COLOR = `${ESC}]112\x07`;

function write(s: string): void {
  if (process.stdout.isTTY) process.stdout.write(s);
}

/**
 * Native terminal cursor hook for the input box. See the JSDoc on
 * {@link UseTerminalCursorOptions} for the placement contract.
 */
export function useTerminalCursor(opts: UseTerminalCursorOptions): void {
  const { value, cursor, inputRow, col = 1, disabled = false, color } = opts;

  // Mount/unmount: hide vs show the OS cursor, restore default blink.
  useEffect(() => {
    if (disabled) return;
    write(HIDE_CURSOR);
    return () => {
      write(SHOW_CURSOR);
      write(RESET_CURSOR_COLOR);
    };
  }, [disabled]);

  // Cursor color via OSC 12 (iTerm2, kitty, wezterm).
  useEffect(() => {
    if (disabled) return;
    if (!color) return;
    write(SET_CURSOR_COLOR(color));
    return () => write(RESET_CURSOR_COLOR);
  }, [color, disabled]);

  // Reposition the OS cursor whenever the cursor offset or the input row
  // changes. When `inputRow` is undefined we do nothing — the caller is
  // signalling "leave the OS cursor hidden, we draw our own glyph".
  useEffect(() => {
    if (disabled) return;
    if (inputRow === undefined) return;
    if (!process.stdout.isTTY) return;
    // Clamp the cursor into the input bounds; out-of-range happens when the
    // input gets longer mid-keystroke and the hook fires before re-measure.
    const maxCol = col + value.length;
    const target = Math.max(col, Math.min(col + cursor, maxCol));
    write(CURSOR_POSITION(inputRow, target));
    // Re-hide in case the OS cursor blinks on at a row change.
    write(HIDE_CURSOR);
  }, [value, cursor, inputRow, col, disabled]);
}
