import { describe, it, expect } from "vitest";
import {
  CENTER_MIN,
  DIVIDER,
  LEFT_MIN,
  RIGHT_MIN,
  ROW_MIN,
  clampPaneWidth,
} from "../../src/paneConstants";

const LEFT_MAX = 720;
const RIGHT_MAX = 960;

// Mirror App.tsx's per-drag siblingMins: the OTHER resizable pane + the center
// minimum + the two dividers between the three panes.
function dragLeft(desired: number, rightWidth: number, container: number) {
  return clampPaneWidth(
    desired,
    LEFT_MIN,
    LEFT_MAX,
    container,
    rightWidth + CENTER_MIN + 2 * DIVIDER
  );
}

function dragRight(desired: number, leftWidth: number, container: number) {
  return clampPaneWidth(
    desired,
    RIGHT_MIN,
    RIGHT_MAX,
    container,
    leftWidth + CENTER_MIN + 2 * DIVIDER
  );
}

// The invariant from the convention: a splitter drag can never push
// left + right + dividers past container − CENTER_MIN, i.e. the center pane
// always keeps at least its own minimum.
function centerSurvives(left: number, right: number, container: number) {
  return left + right + 2 * DIVIDER <= container - CENTER_MIN;
}

describe("clampPaneWidth splitter clamp", () => {
  it("stops a left drag before it crushes the center pane", () => {
    const container = 1200;
    const right = 400;
    // Try to drag the left pane absurdly wide.
    const left = dragLeft(10000, right, container);
    expect(left).toBeGreaterThanOrEqual(LEFT_MIN);
    expect(centerSurvives(left, right, container)).toBe(true);
  });

  it("stops a right drag before it crushes the center pane", () => {
    const container = 1200;
    const left = 300;
    const right = dragRight(10000, left, container);
    expect(right).toBeGreaterThanOrEqual(RIGHT_MIN);
    expect(centerSurvives(left, right, container)).toBe(true);
  });

  it("keeps left + right + dividers ≤ container − CENTER_MIN across many drags", () => {
    const container = ROW_MIN + 200; // a snug but valid container
    for (let desired = 0; desired <= 2000; desired += 50) {
      const right = RIGHT_MIN;
      const left = dragLeft(desired, right, container);
      expect(centerSurvives(left, right, container)).toBe(true);

      const fixedLeft = LEFT_MIN;
      const r = dragRight(desired, fixedLeft, container);
      expect(centerSurvives(fixedLeft, r, container)).toBe(true);
    }
  });

  it("never returns below the pane's own minimum even in a too-narrow container", () => {
    // Container narrower than ROW_MIN: the row scrolls, but the clamp must not
    // invert the bounds and produce something below the pane minimum.
    const container = 200;
    expect(dragLeft(0, RIGHT_MIN, container)).toBe(LEFT_MIN);
    expect(dragRight(0, LEFT_MIN, container)).toBe(RIGHT_MIN);
  });

  it("respects the configured per-pane maximum when the container is roomy", () => {
    const container = 4000;
    expect(dragLeft(10000, RIGHT_MIN, container)).toBe(LEFT_MAX);
    expect(dragRight(10000, LEFT_MIN, container)).toBe(RIGHT_MAX);
  });
});

describe("restored-width clamp on mount", () => {
  it("clamps a stored width wider than the current container down on restore", () => {
    // The window shrank since the width was saved: a stored 700px left pane in a
    // now-narrow container must clamp down so the center pane keeps its minimum.
    const container = 1000;
    const storedLeft = 700;
    const right = RIGHT_MIN;
    const restored = clampPaneWidth(
      storedLeft,
      LEFT_MIN,
      LEFT_MAX,
      container,
      right + CENTER_MIN + 2 * DIVIDER
    );
    expect(restored).toBeLessThan(storedLeft);
    expect(centerSurvives(restored, right, container)).toBe(true);
  });

  it("leaves a stored width that still fits unchanged", () => {
    const container = 1600;
    const storedLeft = 360;
    const restored = clampPaneWidth(
      storedLeft,
      LEFT_MIN,
      LEFT_MAX,
      container,
      RIGHT_MIN + CENTER_MIN + 2 * DIVIDER
    );
    expect(restored).toBe(storedLeft);
  });
});
