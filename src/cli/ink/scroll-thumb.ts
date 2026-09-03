/**
 * Pure scrollbar-thumb geometry.
 *
 * Extracted from ScrollThumb.tsx so the math is unit-testable and reusable.
 * Inputs are in rows; all clamps here are defensive against degenerate values
 * (content ≤ viewport, scroll past the end, etc.).
 *
 * Returns `null` when there is nothing to scroll (content fits in the viewport)
 * — the caller skips rendering the thumb entirely.
 */
export interface ThumbGeometryInput {
  track: number;
  viewport: number;
  content: number;
  scroll: number;
}

export interface ThumbGeometry {
  thumbHeight: number;
  thumbTop: number;
}

export function thumbGeometry({
  track,
  viewport,
  content,
  scroll,
}: ThumbGeometryInput): ThumbGeometry | null {
  if (content <= viewport) return null;
  if (track <= 0 || content <= 0) return null;
  const safeTrack = Math.max(1, track);
  const thumbHeight = Math.max(1, Math.floor((safeTrack * viewport) / content));
  const maxOffset = Math.max(1, content - viewport);
  const thumbTop = Math.max(
    0,
    Math.min(safeTrack - thumbHeight, Math.floor((safeTrack - thumbHeight) * (scroll / maxOffset))),
  );
  return { thumbHeight, thumbTop };
}
