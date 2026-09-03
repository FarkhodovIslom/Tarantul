import { Box, measureElement } from "ink";
import type { DOMElement } from "ink";
import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";

/**
 * WindowedList — manual windowing for Ink transcripts.
 *
 * Only renders items whose position is within `[firstVisible - overscan,
 * lastVisible + overscan]` rows of the current scroll offset. The remaining
 * items are replaced with `<Box height={N} />` spacer rows so the visible
 * geometry stays correct.
 *
 * Item heights are measured per-index via ink's `measureElement` and cached
 * in a Map keyed by item key. The first time a session renders, heights
 * default to `estimatedHeight` until they are measured.
 *
 * The ref API mimics `ink-scroll-view`'s `ScrollViewRef` so the existing App
 * wiring (`scrollBy`, `scrollTo`, `scrollToBottom`, `getBottomOffset`, etc.)
 * keeps working — App.tsx only has to swap `<ScrollView>` for `<WindowedList>`.
 */

export interface WindowedListProps {
  /** The full item list, in chronological order. */
  items: readonly unknown[];
  /** Stable React key for each item. Used for the height cache. */
  itemKey: (item: unknown, index: number) => string;
  /** Initial estimate of each item's row count. Refined after measurement. */
  estimatedHeight?: number;
  /** Height of the viewport in rows (set by App via screen rows - pinned). */
  viewportHeight: number;
  /** Extra rows rendered above/below the visible range. Default 6. */
  overscan?: number;
  /** Render one item. Called only for items in the visible window. */
  renderItem: (item: unknown, index: number) => React.ReactNode;
  /** Controlled scroll offset (positive = content scrolled up). */
  scrollOffset: number;
  onScroll?: (offset: number) => void;
  onContentHeightChange?: (height: number, previousHeight: number) => void;
  /** When true, content is not clipped — useful for debugging layout. */
  debug?: boolean;
}

export interface WindowedListRef {
  scrollBy: (delta: number) => void;
  scrollTo: (offset: number) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  getScrollOffset: () => number;
  getContentHeight: () => number;
  getViewportHeight: () => number;
  getBottomOffset: () => number;
  remeasure: () => void;
}

/** Compute visible [first, last] indices using cumulative offsets + per-item heights. */
export function visibleRange(
  offsets: readonly number[],
  heights: readonly number[],
  viewportTop: number,
  viewportHeight: number,
): { first: number; last: number } {
  if (offsets.length === 0) return { first: 0, last: -1 };
  let first = 0;
  for (let i = 0; i < offsets.length; i++) {
    const top = offsets[i] ?? 0;
    const h = heights[i] ?? 0;
    if (top + h > viewportTop) {
      first = i;
      break;
    }
  }
  let last = first;
  for (let i = first; i < offsets.length; i++) {
    const top = offsets[i] ?? 0;
    const h = heights[i] ?? 0;
    if (top + h > viewportTop + viewportHeight) {
      last = Math.max(first, i - 1);
      break;
    }
    last = i;
  }
  return { first, last };
}

function sumHeights(heights: readonly number[], count: number, fallback: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += heights[i] ?? fallback;
  return total;
}

function buildOffsets(heights: readonly number[], count: number, fallback: number): number[] {
  const offsets = new Array<number>(count);
  let acc = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] = acc;
    acc += heights[i] ?? fallback;
  }
  return offsets;
}

/**
 * The non-generic implementation. We erase the generic at the boundary so
 * `forwardRef` can type-check cleanly without `forwardRef` overload juggling.
 * The type-safe wrapper below restores the generic for callers.
 */
function WindowedListImpl(
  props: WindowedListProps,
  ref: React.Ref<WindowedListRef>,
): React.ReactElement {
  const {
    items,
    itemKey,
    estimatedHeight = 3,
    viewportHeight,
    overscan = 6,
    renderItem,
    scrollOffset,
    onScroll,
    onContentHeightChange,
    debug = false,
  } = props;

  // -------------------------------------------------------------------------
  // Refs for the imperative API + measurement.
  // -------------------------------------------------------------------------
  const viewportNodeRef = useRef<DOMElement | null>(null);
  const itemNodesRef = useRef<Map<number, DOMElement>>(new Map());
  const itemHeightsRef = useRef<Map<string, number>>(new Map());
  const scrollOffsetRef = useRef<number>(scrollOffset);
  const prevTotalRef = useRef<number>(0);

  // Bump counter — incremented when measurement changes require a re-render.
  const [version, setVersion] = useState(0);
  const [measuredViewport, setMeasuredViewport] = useState({ width: 0, height: viewportHeight });

  // -------------------------------------------------------------------------
  // Heights + offsets. Re-derived whenever the items reference or the bump
  // counter changes (measurement triggers a bump).
  // -------------------------------------------------------------------------
  const { heights, offsets, totalHeight } = useMemo(() => {
    const h = new Array<number>(items.length);
    for (let i = 0; i < items.length; i++) {
      const key = itemKey(items[i], i);
      h[i] = itemHeightsRef.current.get(key) ?? estimatedHeight;
    }
    const o = buildOffsets(h, items.length, estimatedHeight);
    return { heights: h, offsets: o, totalHeight: sumHeights(h, items.length, estimatedHeight) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, version]);

  const effectiveViewport = measuredViewport.height > 0 ? measuredViewport.height : viewportHeight;

  // -------------------------------------------------------------------------
  // Notify on content height changes (after measurement refinement).
  // -------------------------------------------------------------------------
  useLayoutEffect(() => {
    if (prevTotalRef.current !== totalHeight) {
      onContentHeightChange?.(totalHeight, prevTotalRef.current);
      prevTotalRef.current = totalHeight;
    }
  }, [totalHeight, onContentHeightChange]);

  // -------------------------------------------------------------------------
  // Measure the viewport once mounted and after resize.
  // -------------------------------------------------------------------------
  useLayoutEffect(() => {
    const node = viewportNodeRef.current;
    if (!node) return;
    const m = measureElement(node);
    setMeasuredViewport({ width: m.width, height: m.height });
  }, [viewportHeight]);

  // -------------------------------------------------------------------------
  // Visible range.
  // -------------------------------------------------------------------------
  const { first, last } = useMemo(
    () => visibleRange(offsets, heights, scrollOffset, effectiveViewport),
    [offsets, heights, scrollOffset, effectiveViewport],
  );

  const firstRender = Math.max(0, first - overscan);
  const lastRender = Math.min(items.length - 1, last + overscan);

  const topSpacerHeight = offsets[firstRender] ?? 0;

  let bottomSpacerHeight = 0;
  const nextIdx = lastRender + 1;
  if (nextIdx < items.length) {
    const topOfRemaining = offsets[nextIdx] ?? 0;
    const lastTotal =
      (offsets[items.length - 1] ?? 0) + (heights[items.length - 1] ?? estimatedHeight);
    bottomSpacerHeight = lastTotal - topOfRemaining;
  }

  // -------------------------------------------------------------------------
  // Measure a single item after layout. Caches the result by itemKey and
  // bumps the version counter to trigger an offsets re-derivation.
  // -------------------------------------------------------------------------
  const measureItem = (index: number): void => {
    const node = itemNodesRef.current.get(index);
    if (!node) return;
    const key = itemKey(items[index], index);
    const m = measureElement(node);
    const previous = itemHeightsRef.current.get(key);
    if (previous !== m.height) {
      itemHeightsRef.current.set(key, m.height);
      setVersion((v) => v + 1);
    }
  };

  const setItemNode = (index: number, node: DOMElement | null): void => {
    if (node) {
      itemNodesRef.current.set(index, node);
      // Defer to a layout effect to read post-layout measurements.
      queueMicrotask(() => measureItem(index));
    } else {
      itemNodesRef.current.delete(index);
    }
  };

  // -------------------------------------------------------------------------
  // Imperative ref API.
  // -------------------------------------------------------------------------
  const setOffset = (next: number): void => {
    const max = Math.max(0, totalHeight - effectiveViewport);
    const clamped = Math.max(0, Math.min(max, next));
    if (clamped !== scrollOffsetRef.current) {
      scrollOffsetRef.current = clamped;
      onScroll?.(clamped);
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      scrollBy: (delta) => setOffset(scrollOffsetRef.current + delta),
      scrollTo: (offset) => setOffset(offset),
      scrollToTop: () => setOffset(0),
      scrollToBottom: () => setOffset(Math.max(0, totalHeight - effectiveViewport)),
      getScrollOffset: () => scrollOffsetRef.current,
      getContentHeight: () => totalHeight,
      getViewportHeight: () => effectiveViewport,
      getBottomOffset: () => Math.max(0, totalHeight - effectiveViewport),
      remeasure: () => {
        const node = viewportNodeRef.current;
        if (!node) return;
        const m = measureElement(node);
        setMeasuredViewport({ width: m.width, height: m.height });
        for (const index of itemNodesRef.current.keys()) measureItem(index);
      },
    }),
    [totalHeight, effectiveViewport, onScroll],
  );

  scrollOffsetRef.current = scrollOffset;

  return (
    <Box ref={viewportNodeRef} width="100%" flexDirection="column" height={effectiveViewport}>
      <Box
        width="100%"
        flexDirection="column"
        marginTop={-scrollOffset}
        overflow={debug ? undefined : "hidden"}
      >
        {topSpacerHeight > 0 ? <Box width="100%" height={topSpacerHeight} flexShrink={0} /> : null}
        {items.slice(firstRender, lastRender + 1).map((item, sliceIdx) => {
          const index = firstRender + sliceIdx;
          return (
            <Box
              key={itemKey(item, index)}
              ref={(node: DOMElement | null) => setItemNode(index, node)}
              flexShrink={0}
              width="100%"
              flexDirection="column"
            >
              {renderItem(item, index)}
            </Box>
          );
        })}
        {bottomSpacerHeight > 0 ? (
          <Box width="100%" height={bottomSpacerHeight} flexShrink={0} />
        ) : null}
      </Box>
    </Box>
  );
}

/**
 * Type-erased public wrapper. The non-generic `WindowedListImpl` carries the
 * ref forwarding; this wrapper restores the generic at the call site.
 */
export const WindowedList = forwardRef(WindowedListImpl) as <T>(
  props: Omit<WindowedListProps, "items" | "itemKey" | "renderItem"> & {
    items: readonly T[];
    itemKey: (item: T, index: number) => string;
    renderItem: (item: T, index: number) => React.ReactNode;
    ref?: React.Ref<WindowedListRef>;
  },
) => React.ReactElement;
