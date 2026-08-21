// Small environment-neutral contracts from src/shared: the asset-protocol URL
// encoding and the derived window-minimum (app-chrome-conventions: window min =
// sum of pane mins + chrome, never hand-typed).

import { describe, it, expect } from "vitest";
import { assetUrl, ASSET_SCHEME } from "@shared/ipc";
import {
  LEFT_MIN,
  RIGHT_MIN,
  CENTER_MIN,
  DIVIDER,
  WINDOW_MIN_WIDTH,
  WINDOW_MIN_HEIGHT,
} from "@shared/layout";

describe("assetUrl", () => {
  it("builds a scheme URL with each id as an encoded path segment under the asset host", () => {
    expect(assetUrl("ws1", "p1", "pic.png")).toBe(`${ASSET_SCHEME}://asset/ws1/p1/pic.png`);
  });

  it("percent-encodes segments so spaces and slashes cannot escape the path", () => {
    const url = assetUrl("w s", "p/1", "a b.png");
    expect(url).toBe(`${ASSET_SCHEME}://asset/w%20s/p%2F1/a%20b.png`);
    // The case-sensitive ids live in the path, not the (lowercased) host.
    expect(url).toContain("://asset/");
  });
});

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
});
