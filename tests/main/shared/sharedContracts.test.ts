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
  ROW_MIN,
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

describe("window-minimum derivation", () => {
  it("derives ROW_MIN as the sum of the pane minimums plus the dividers", () => {
    expect(ROW_MIN).toBe(LEFT_MIN + CENTER_MIN + RIGHT_MIN + 2 * DIVIDER);
  });

  it("ties the window minimum width to the pane row (no extra horizontal chrome)", () => {
    expect(WINDOW_MIN_WIDTH).toBe(ROW_MIN);
    expect(WINDOW_MIN_HEIGHT).toBeGreaterThan(0);
  });
});
