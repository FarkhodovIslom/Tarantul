import { describe, expect, it } from "bun:test";
import { thumbGeometry } from "../src/cli/ink/scroll-thumb.js";

/** Narrowing helper: biome disallows `!` assertions, so use an explicit guard. */
function expectGeom(result: ReturnType<typeof thumbGeometry>): {
  thumbHeight: number;
  thumbTop: number;
} {
  expect(result).not.toBeNull();
  if (result === null) throw new Error("unreachable");
  return result;
}

describe("thumbGeometry", () => {
  it("returns null when content fits in the viewport (nothing to scroll)", () => {
    expect(thumbGeometry({ track: 10, viewport: 20, content: 20, scroll: 0 })).toBeNull();
    expect(thumbGeometry({ track: 10, viewport: 20, content: 10, scroll: 0 })).toBeNull();
  });

  it("returns null for degenerate (non-positive) inputs", () => {
    expect(thumbGeometry({ track: 0, viewport: 10, content: 100, scroll: 0 })).toBeNull();
    expect(thumbGeometry({ track: 10, viewport: 10, content: 0, scroll: 0 })).toBeNull();
  });

  it("produces a thumb proportional to viewport/content", () => {
    const g = expectGeom(thumbGeometry({ track: 20, viewport: 10, content: 100, scroll: 0 }));
    expect(g.thumbHeight).toBe(Math.floor((20 * 10) / 100)); // 2
    expect(g.thumbTop).toBe(0);
  });

  it("clamps the thumb to the top of the track at scroll = 0", () => {
    const g = expectGeom(thumbGeometry({ track: 20, viewport: 5, content: 50, scroll: 0 }));
    expect(g.thumbTop).toBe(0);
  });

  it("clamps the thumb to the bottom of the track at scroll = max", () => {
    const g = expectGeom(thumbGeometry({ track: 20, viewport: 5, content: 50, scroll: 1000 }));
    expect(g.thumbTop).toBeLessThanOrEqual(20 - g.thumbHeight);
    expect(g.thumbTop).toBeGreaterThanOrEqual(0);
  });

  it("is safe against divide-by-zero when content barely exceeds viewport", () => {
    const g = expectGeom(thumbGeometry({ track: 20, viewport: 20, content: 21, scroll: 0 }));
    expect(g.thumbHeight).toBeGreaterThanOrEqual(1);
    expect(g.thumbTop).toBe(0);
  });

  it("thumbHeight is at least 1 even when content is huge", () => {
    const g = expectGeom(thumbGeometry({ track: 20, viewport: 1, content: 1_000_000, scroll: 0 }));
    expect(g.thumbHeight).toBeGreaterThanOrEqual(1);
  });
});
