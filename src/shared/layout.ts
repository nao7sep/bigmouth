// Pane-sizing constants shared by the renderer's splitter logic (paneConstants)
// and the main process's window-minimum derivation (window.ts), so the two can
// never disagree. Per the app-chrome-conventions the window minimum is the sum of
// the pane minimums plus the fixed chrome — derived here, never hand-typed.

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
