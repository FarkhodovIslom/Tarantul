import { describe, expect, it } from "bun:test";
import { visibleRange } from "../src/cli/ink/WindowedList.js";

describe("WindowedList.visibleRange", () => {
  it("returns an empty range when there are no items", () => {
    const out = visibleRange([], [], 0, 10);
    expect(out).toEqual({ first: 0, last: -1 });
  });

  it("returns the only item when there is exactly one", () => {
    const out = visibleRange([0], [5], 0, 10);
    expect(out).toEqual({ first: 0, last: 0 });
  });

  it("includes the first item when the viewport starts at the top", () => {
    const offsets = [0, 3, 6, 9, 12];
    const heights = [3, 3, 3, 3, 3];
    const out = visibleRange(offsets, heights, 0, 6);
    expect(out.first).toBe(0);
    expect(out.last).toBe(1);
  });

  it("handles scrolling halfway through the list", () => {
    const offsets = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27];
    const heights = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
    const out = visibleRange(offsets, heights, 12, 9);
    expect(out.first).toBe(4);
    expect(out.last).toBe(6);
  });

  it("clamps the last index to the end when the viewport extends past the list", () => {
    const offsets = [0, 3, 6, 9, 12];
    const heights = [3, 3, 3, 3, 3];
    const out = visibleRange(offsets, heights, 0, 100);
    expect(out.first).toBe(0);
    expect(out.last).toBe(4);
  });

  it("returns the final item when the viewport is scrolled to the very bottom", () => {
    const offsets = [0, 3, 6, 9, 12];
    const heights = [3, 3, 3, 3, 3];
    const out = visibleRange(offsets, heights, 9, 6);
    expect(out.first).toBeGreaterThanOrEqual(3);
    expect(out.last).toBe(4);
  });

  it("handles variable item heights", () => {
    const offsets = [0, 2, 7, 10, 18];
    const heights = [2, 5, 3, 8, 4];
    // Viewport shows rows 7..15 — should cover item index 2 fully and item 3 partially.
    const out = visibleRange(offsets, heights, 7, 8);
    expect(out.first).toBe(2);
    expect(out.last).toBeGreaterThanOrEqual(2);
    expect(out.last).toBeLessThanOrEqual(3);
  });
});
