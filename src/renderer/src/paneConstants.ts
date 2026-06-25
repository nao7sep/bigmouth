// The pane-sizing constants are the single source of truth in @shared/layout
// (also consumed by the main process's window minimum, so the window can never be
// dragged narrow enough to truncate a pane). They are re-exported here for the
// renderer's existing call sites; this module adds the renderer-only splitter
// clamp helpers. Per the app-chrome-conventions: each pane declares a real
// minimum, the center (primary) pane never collapses, and a splitter drag can
// never consume a sibling's minimum. The constants also mirror the `min-width`
// rules in App.css; if one changes, change both.
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
