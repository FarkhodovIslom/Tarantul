import { Box, Text } from "ink";
import { memo } from "react";
import type React from "react";
import { thumbGeometry } from "./scroll-thumb.js";
import { layout } from "./theme.js";

/**
 * Rendered scrollbar thumb for the windowed viewport.
 *
 * Drawn as a single column of full-block glyphs; the active thumb rows are
 * tinted with `layout.scrollbar.thumb`, the rest with `layout.scrollbar.track`.
 * The actual geometry (height + position) is delegated to `thumbGeometry` so
 * the math is unit-tested independently of React.
 */
export interface ScrollThumbProps {
  contentHeight: number;
  viewportHeight: number;
  scrollOffset: number;
  /** How many rows to draw in the column. Defaults to the viewport height. */
  trackHeight?: number;
}

export const ScrollThumb = memo(function ScrollThumb({
  contentHeight,
  viewportHeight,
  scrollOffset,
  trackHeight,
}: ScrollThumbProps): React.ReactElement | null {
  const track = trackHeight ?? Math.max(1, viewportHeight);
  const geom = thumbGeometry({
    track,
    viewport: viewportHeight,
    content: contentHeight,
    scroll: scrollOffset,
  });
  if (!geom) return null;

  const { thumbHeight, thumbTop } = geom;
  const rows: React.ReactElement[] = [];
  for (let i = 0; i < track; i++) {
    const inThumb = i >= thumbTop && i < thumbTop + thumbHeight;
    rows.push(
      <Text key={`thumb-${i}`} color={inThumb ? layout.scrollbar.thumb : layout.scrollbar.track}>
        {inThumb ? "█" : "▁"}
      </Text>,
    );
  }

  return (
    <Box flexDirection="column" width={1} flexShrink={0}>
      {rows}
    </Box>
  );
});
