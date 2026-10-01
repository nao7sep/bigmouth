// Pane sizes come from @shared/layout (window-conventions); this module adds
// renderer-only splitter clamps. App.css mirrors these constants.
export { LEFT_MIN, RIGHT_MIN, CENTER_MIN, DIVIDER, ROW_MIN } from "@shared/layout";

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
