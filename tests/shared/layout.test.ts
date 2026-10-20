import { describe, it, expect } from "vitest";
import {
  LEFT_MIN,
  RIGHT_MIN,
  CENTER_MIN,
  DIVIDER,
  WINDOW_MIN_WIDTH,
  WINDOW_MIN_HEIGHT,
  windowMinimumForZoom,
  RECORDS_DETAIL_MIN_WIDTH,
  RECORDS_FILTERS_HEIGHT,
  RECORDS_LIST_MIN_HEIGHT,
  RECORDS_LIST_WIDTH,
  RECORDS_WINDOW_MIN_HEIGHT,
  RECORDS_WINDOW_MIN_WIDTH,
} from "@shared/layout";

describe("window minimums", () => {
  // Deliberately NOT `ROW_MIN === LEFT_MIN + CENTER_MIN + RIGHT_MIN + 2*DIVIDER`:
  // that restates layout.ts's own expression, so it cannot fail while the source
  // stands and protects nothing. What can actually go wrong is a pane minimum
  // being raised without the window minimum following, so the window becomes
  // draggable narrow enough to crush a pane — which is a property, not a copy of
  // the formula.
  it("is wide enough to hold all three panes and the dividers between them", () => {
    expect(WINDOW_MIN_WIDTH).toBeGreaterThanOrEqual(
      LEFT_MIN + CENTER_MIN + RIGHT_MIN + 2 * DIVIDER,
    );
  });

  it("gives every pane a real minimum, so none can be squeezed away", () => {
    for (const min of [LEFT_MIN, CENTER_MIN, RIGHT_MIN]) {
      expect(min).toBeGreaterThan(0);
    }
    expect(WINDOW_MIN_HEIGHT).toBeGreaterThan(0);
  });

  it("scales the native floor with Electron zoom so the CSS pane floors remain real", () => {
    expect(windowMinimumForZoom(1)).toEqual({
      width: WINDOW_MIN_WIDTH,
      height: WINDOW_MIN_HEIGHT,
    });
    // Whole device pixels, never less than the zoomed CSS floor needs.
    for (const zoom of [0.8, 1.2, 1.5, 1.728]) {
      const { width, height } = windowMinimumForZoom(zoom);
      for (const [value, floor] of [[width, WINDOW_MIN_WIDTH * zoom], [height, WINDOW_MIN_HEIGHT * zoom]] as const) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(floor);
        expect(value).toBeLessThan(floor + 1);
      }
    }
  });
});

describe("records window minimums", () => {
  it("holds the list pane, the divider and the detail pane at their minimums", () => {
    expect(RECORDS_WINDOW_MIN_WIDTH).toBeGreaterThanOrEqual(RECORDS_LIST_WIDTH.min + DIVIDER + RECORDS_DETAIL_MIN_WIDTH);
  });

  it("holds the filter band above a usable list", () => {
    expect(RECORDS_WINDOW_MIN_HEIGHT).toBeGreaterThanOrEqual(RECORDS_FILTERS_HEIGHT + RECORDS_LIST_MIN_HEIGHT);
  });

  it("opens the list pane at its default within its bounds", () => {
    expect(RECORDS_LIST_WIDTH.min).toBeLessThanOrEqual(RECORDS_LIST_WIDTH.default);
    expect(RECORDS_LIST_WIDTH.default).toBeLessThanOrEqual(RECORDS_LIST_WIDTH.max);
  });
});
