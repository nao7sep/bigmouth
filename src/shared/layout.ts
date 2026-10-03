// Geometry shared by renderer splitters and the main-process window.
// Pane-sizing policy: window-conventions.

export const LEFT_MIN = 240;
export const RIGHT_MIN = 320;
export const CENTER_MIN = 360;
export const DIVIDER = 5;

/** The smallest the three-pane row can be without crushing any pane. */
export const ROW_MIN = LEFT_MIN + CENTER_MIN + RIGHT_MIN + 2 * DIVIDER;

/**
 * Window minimums. Width is the pane-row minimum — the panes fill the content
 * width with no extra horizontal chrome, so the window can never be dragged
 * narrow enough to truncate a pane. Height is the smallest at which the editor
 * and its tab strip stay usable; there is no vertical pane split to sum, so it is
 * a single designed content minimum rather than a per-pane total.
 */
export const WINDOW_MIN_WIDTH = ROW_MIN;
export const WINDOW_MIN_HEIGHT = 600;

/**
 * Electron zoom reduces the number of CSS pixels available inside a native
 * window. Scale the native floor with it so zooming cannot make any pane's CSS
 * minimum impossible to satisfy. The returned values remain device-pixel
 * integers for BrowserWindow.setMinimumSize().
 */
export function windowMinimumForZoom(zoomFactor: number): { width: number; height: number } {
  return {
    width: Math.ceil(WINDOW_MIN_WIDTH * zoomFactor),
    height: Math.ceil(WINDOW_MIN_HEIGHT * zoomFactor),
  };
}

// The records window: a user-adjustable list pane (filters above the record
// list) beside the detail pane, which takes the rest, with the shared divider
// between them. Mirrors `.records-*` in src/renderer/src/App.css.
export const RECORDS_LIST_WIDTH = { min: 320, default: 380, max: 640 } as const;
export const RECORDS_DETAIL_MIN_WIDTH = 420;
// The filter band: 12px padding above and below a search field and two rows of
// selects (three 32px controls, 8px apart), and the line below it.
export const RECORDS_FILTERS_HEIGHT = 12 * 2 + 32 * 3 + 8 * 2 + 1;
export const RECORDS_LIST_MIN_HEIGHT = 160;

// Derived — do not hand-edit.
export const RECORDS_WINDOW_MIN_WIDTH = RECORDS_LIST_WIDTH.min + DIVIDER + RECORDS_DETAIL_MIN_WIDTH;

// Derived — do not hand-edit.
export const RECORDS_WINDOW_MIN_HEIGHT = RECORDS_FILTERS_HEIGHT + RECORDS_LIST_MIN_HEIGHT;
