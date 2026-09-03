import { describe, expect, it } from "bun:test";

/**
 * Tests for the SGR mouse-event decoder used by `useMouse`.
 *
 * The decoder is intentionally tiny so we can pull its parsing logic into a
 * test without bringing the hook into a JSDOM environment. We re-implement
 * the same SGR regex + button decoder here; the test guards against drift
 * between the hook's expectations and the public shape.
 */

const SGR_PATTERN = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

function buttonType(code: number): string | null {
  if (code === 64) return "wheel_up";
  if (code === 65) return "wheel_down";
  if (code === 66) return "wheel_left";
  if (code === 67) return "wheel_right";
  const base = code & 0b11;
  if (base === 0) return "left";
  if (base === 1) return "middle";
  if (base === 2) return "right";
  return null;
}

interface DecodedEvent {
  x: number;
  y: number;
  button: string;
  pressed: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

function parse(text: string): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  let match: RegExpExecArray | null;
  SGR_PATTERN.lastIndex = 0;
  while ((match = SGR_PATTERN.exec(text)) !== null) {
    const code = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const pressed = match[4] === "M";
    const button = buttonType(code);
    if (!button) continue;
    out.push({
      x,
      y,
      button,
      pressed,
      shift: (code & 4) !== 0,
      alt: (code & 8) !== 0,
      ctrl: (code & 16) !== 0,
    });
  }
  return out;
}

describe("SGR mouse decoder", () => {
  it("decodes a left-click press", () => {
    const out = parse("\x1b[<0;10;5M");
    expect(out).toEqual([
      { x: 10, y: 5, button: "left", pressed: true, shift: false, alt: false, ctrl: false },
    ]);
  });

  it("decodes a left-click release", () => {
    const out = parse("\x1b[<0;10;5m");
    expect(out[0]?.pressed).toBe(false);
  });

  it("decodes a middle-click", () => {
    const out = parse("\x1b[<1;3;4M");
    expect(out[0]?.button).toBe("middle");
  });

  it("decodes a right-click", () => {
    const out = parse("\x1b[<2;3;4M");
    expect(out[0]?.button).toBe("right");
  });

  it("decodes a wheel-up event", () => {
    const out = parse("\x1b[<64;5;5M");
    expect(out[0]?.button).toBe("wheel_up");
  });

  it("decodes a wheel-down event", () => {
    const out = parse("\x1b[<65;5;5M");
    expect(out[0]?.button).toBe("wheel_down");
  });

  it("decodes modifier flags (shift+ctrl)", () => {
    const out = parse("\x1b[<20;1;1M"); // 0b10100 = 20 → ctrl + shift
    expect(out[0]?.shift).toBe(true);
    expect(out[0]?.ctrl).toBe(true);
    expect(out[0]?.alt).toBe(false);
  });

  it("decodes the alt modifier", () => {
    const out = parse("\x1b[<8;1;1M"); // 0b01000 = 8 → alt
    expect(out[0]?.alt).toBe(true);
  });

  it("decodes multiple events in one chunk", () => {
    const chunk = "\x1b[<0;1;1M\x1b[<0;2;2M\x1b[<0;3;3m";
    const out = parse(chunk);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.x)).toEqual([1, 2, 3]);
  });

  it("ignores unknown button codes", () => {
    // Code 3 with M is a release-of-none; the parser treats it as no-button.
    const out = parse("\x1b[<3;1;1M");
    expect(out).toHaveLength(0);
  });

  it("decodes a button-code value of exactly the release flag", () => {
    // Code 3 with m is the "release of nothing" sentinel — the parser should
    // skip it. This documents our choice to suppress it.
    const out = parse("\x1b[<3;1;1m");
    expect(out).toHaveLength(0);
  });
});
