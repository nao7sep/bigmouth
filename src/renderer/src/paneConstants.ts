// Shared pane-sizing constants and the splitter clamp, kept in one place so the
// CSS minimums (App.css), the drag clamp (App.tsx), and the restored-width
// clamp all agree. Per the window-chrome-conventions: each pane declares a real
// minimum, the center (primary) pane never collapses, and a splitter drag can
// never consume a sibling's minimum.
//
// These mirror the `min-width` rules in App.css; if one changes, change both.
export const LEFT_MIN = 240;
export const RIGHT_MIN = 320;
export const CENTER_MIN = 360;
export const DIVIDER = 5;

// The smallest the whole pane row can be without crushing any pane. Below this
// the row scrolls (`.app-layout { overflow-x: auto }`) rather than collapsing.
export const ROW_MIN = LEFT_MIN + CENTER_MIN + RIGHT_MIN + 2 * DIVIDER;

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
