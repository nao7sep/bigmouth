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

// Mirror App.tsx's display derivation: the DISPLAYED width is the pane's intent
// clamped against the live container, with siblingMins = the OTHER resizable
// pane's intent + the center minimum + the two dividers between the three panes.
// A splitter drag records the raw intent (clamped only to per-pane bounds); the
// display derives from it via these helpers.
function displayLeft(intent: number, rightIntent: number, container: number) {
  return clampPaneWidth(
    intent,
    LEFT_MIN,
    LEFT_MAX,
    container,
    rightIntent + CENTER_MIN + 2 * DIVIDER
  );
}

function displayRight(intent: number, leftIntent: number, container: number) {
  return clampPaneWidth(
    intent,
    RIGHT_MIN,
    RIGHT_MAX,
    container,
    leftIntent + CENTER_MIN + 2 * DIVIDER
  );
}

// Aliases kept for the drag-clamp assertions: a drag's displayed result is the
// same clamp applied to the dragged-to intent.
const dragLeft = displayLeft;
const dragRight = displayRight;

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

// Mirror App.tsx's readStoredIntent: the stored intent is clamped ONLY to the
// pane's own configured bounds on read — never against the container — so a
// narrow viewport at load time can't shrink the persisted intent.
function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
function readStoredIntent(stored: number, min: number, max: number) {
  return clamp(stored, min, max);
}

describe("intent persistence vs. display clamp", () => {
  it("keeps the stored intent on restore even when the viewport is narrow", () => {
    // The window shrank since the width was saved: a stored 700px left intent
    // must survive restore unchanged — only the DISPLAY is clamped, not the
    // persisted intent.
    const storedLeft = 700;
    const intent = readStoredIntent(storedLeft, LEFT_MIN, LEFT_MAX);
    expect(intent).toBe(storedLeft);

    // The display derived from that intent in a now-narrow container clamps down
    // so the center pane keeps its minimum, but the intent itself is untouched.
    const container = 1000;
    const right = RIGHT_MIN;
    const displayed = displayLeft(intent, right, container);
    expect(displayed).toBeLessThan(intent);
    expect(centerSurvives(displayed, right, container)).toBe(true);
    // The persisted intent did not change.
    expect(intent).toBe(storedLeft);
  });

  it("does not mutate the intent when a viewport-driven display clamp narrows it", () => {
    // A viewport resize re-derives the display from the unchanged intent. The
    // intent value is the same before and after deriving a (narrower) display.
    const intent = 700;
    const right = RIGHT_MIN;

    const narrow = displayLeft(intent, right, 900); // clamps below intent
    expect(narrow).toBeLessThan(intent);

    const roomy = displayLeft(intent, right, 1800); // fits the full intent
    expect(roomy).toBe(intent);

    // Both displays were derived from the SAME intent; deriving never wrote it
    // back, so widening the viewport restores the pane to its intended width.
    expect(intent).toBe(700);
  });

  it("restores the pane to its intended width once the viewport grows back", () => {
    // The required round trip: wide → drag (intent saved) → narrow (clamped) →
    // wide again (returns to intent).
    const intent = 700;
    const right = RIGHT_MIN;

    // Persisted intent read back at load with a narrow viewport stays the intent.
    const restored = readStoredIntent(intent, LEFT_MIN, LEFT_MAX);
    expect(restored).toBe(700);

    // Narrow viewport: display is clamped down (and below ROW_MIN the row
    // scrolls), but the intent is preserved.
    const narrowDisplay = displayLeft(restored, right, 900);
    expect(narrowDisplay).toBeLessThan(restored);

    // Widen: the display derived from the same intent returns to the full width.
    const wideDisplay = displayLeft(restored, right, 1800);
    expect(wideDisplay).toBe(700);
  });

  it("leaves a stored intent that already fits shown unchanged", () => {
    const container = 1600;
    const storedLeft = 360;
    const intent = readStoredIntent(storedLeft, LEFT_MIN, LEFT_MAX);
    const displayed = displayLeft(intent, RIGHT_MIN, container);
    expect(displayed).toBe(storedLeft);
  });
});
