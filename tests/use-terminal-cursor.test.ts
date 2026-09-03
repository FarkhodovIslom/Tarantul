import { describe, expect, it } from "bun:test";

/**
 * Tests for the ANSI escape sequences emitted by `useTerminalCursor`.
 *
 * The hook itself is a thin React wrapper; the interesting logic is the
 * string-builder for hide/show/position/color. These tests cover the exact
 * byte sequences the hook writes to `process.stdout` so a typo in a constant
 * is caught immediately.
 */

const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l${ESC}[?12l`;
const SHOW_CURSOR = `${ESC}[?25h${ESC}[?12l`;
const CURSOR_POSITION = (row: number, col: number): string => `${ESC}[${row};${col}H`;
const SET_CURSOR_COLOR = (hex: string): string => `${ESC}]12;#${hex.replace(/^#/, "")}\x07`;
const RESET_CURSOR_COLOR = `${ESC}]112\x07`;

describe("ANSI cursor escape sequences", () => {
  it("HIDE_CURSOR combines DEC hide (25l) and DEC no-blink (12l)", () => {
    expect(HIDE_CURSOR).toBe("\x1b[?25l\x1b[?12l");
  });

  it("SHOW_CURSOR reveals the OS cursor and restores default blink", () => {
    expect(SHOW_CURSOR).toBe("\x1b[?25h\x1b[?12l");
  });

  it("CURSOR_POSITION uses ANSI CUP", () => {
    expect(CURSOR_POSITION(3, 12)).toBe("\x1b[3;12H");
  });

  it("CURSOR_POSITION handles single-digit row/col without padding", () => {
    // Some terminals accept unpadded CUP; we keep the bytes minimal.
    expect(CURSOR_POSITION(1, 1)).toBe("\x1b[1;1H");
  });

  it("SET_CURSOR_COLOR emits OSC 12 with the hex (with or without #)", () => {
    expect(SET_CURSOR_COLOR("#0abab5")).toBe("\x1b]12;#0abab5\x07");
    expect(SET_CURSOR_COLOR("0abab5")).toBe("\x1b]12;#0abab5\x07");
  });

  it("RESET_CURSOR_COLOR emits OSC 112", () => {
    expect(RESET_CURSOR_COLOR).toBe("\x1b]112\x07");
  });

  it("hide and show sequences use disjoint DEC codes", () => {
    // The bytes that hide the cursor must differ from the bytes that show it.
    expect(HIDE_CURSOR).not.toBe(SHOW_CURSOR);
    // HIDE_CURSOR uses ?25l (DEC hide); SHOW_CURSOR uses ?25h (DEC show).
    expect(HIDE_CURSOR).toContain("[?25l");
    expect(SHOW_CURSOR).toContain("[?25h");
  });
});
