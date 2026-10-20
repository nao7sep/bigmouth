// Pane sizes come from @shared/layout (window-conventions); this module adds
// renderer-only splitter clamps. The stylesheet restates these values, which CSS
// cannot import; a test compares them.
import { CENTER_MIN, DIVIDER, LEFT_MIN, RIGHT_MIN } from "@shared/layout";

export { LEFT_MIN, RIGHT_MIN, CENTER_MIN, DIVIDER, ROW_MIN } from "@shared/layout";

// Per-pane configured bounds. The lower bound is the pane's own minimum; the
// upper bound is the widest the pane can grow at all. The live splitter clamp
// (clampPaneWidth) tightens the upper bound further against the container so a
// widened pane never crushes the center pane.
export const LEFT_MAX = 720;
export const RIGHT_MAX = 960;

export function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

// The largest a resizable pane may take given the live container width, so that
// its siblings plus the center pane keep at least their own minimums. When the
// container is itself below ROW_MIN the row scrolls, so the pane is still free
// to grow up to its own configured `max` (the row simply overflows). The result
// is never below `paneMin`, so a too-narrow container can't invert the bounds.
//
// siblingMins = sum of the OTHER resizable pane's min + the center min + the
// dividers between them.
export function clampPaneWidth(
  desired: number,
  paneMin: number,
  paneMax: number,
  containerWidth: number,
  siblingMins: number
): number {
  const fitMax = containerWidth - siblingMins;
  const max = Math.min(paneMax, Math.max(paneMin, fitMax));
  return clamp(desired, paneMin, max);
}

// A side pane's displayed width: its intent clamped against the live container,
// with the other side pane's intent, the center minimum and the two dividers as
// the siblings it must leave room for.
export function displayedLeftWidth(leftIntent: number, rightIntent: number, containerWidth: number): number {
  return clampPaneWidth(leftIntent, LEFT_MIN, LEFT_MAX, containerWidth, rightIntent + CENTER_MIN + 2 * DIVIDER);
}

export function displayedRightWidth(rightIntent: number, leftIntent: number, containerWidth: number): number {
  return clampPaneWidth(rightIntent, RIGHT_MIN, RIGHT_MAX, containerWidth, leftIntent + CENTER_MIN + 2 * DIVIDER);
}

// A stored intent is clamped only to its pane's own bounds on read, never
// against the container, so a narrow window at load cannot shrink it.
export function restoredLeftIntent(stored: number): number {
  return clamp(stored, LEFT_MIN, LEFT_MAX);
}

export function restoredRightIntent(stored: number): number {
  return clamp(stored, RIGHT_MIN, RIGHT_MAX);
}
