import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CENTER_MIN, LEFT_MIN, RIGHT_MIN } from "@shared/layout";

// Load the stylesheet into jsdom and check the values the browser computes,
// rather than matching the spelling or placement of individual CSS rules.
const css = readFileSync(`${process.cwd()}/src/renderer/src/App.css`, "utf8");
// A computed-style check rather than a text match: the question is what the user
// actually gets, and a `cursor: pointer` declared later would beat a rule that
// merely appears in the file.
describe("App.css disabled cursors", () => {
  function cursorOf(className: string, disabled: boolean): string {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const button = document.createElement("button");
    button.className = className;
    if (disabled) button.disabled = true;
    document.body.appendChild(button);

    const cursor = getComputedStyle(button).cursor;
    button.remove();
    style.remove();
    return cursor;
  }

  // Every one of these kept the hand while dead, because the reset was written
  // per button class in six places and these were not among them.
  it.each(["btn-toolbar", "asset-btn", "meta-field-copy", "btn-export", "btn-primary", "action-button"])(
    "%s shows the arrow when disabled",
    (className) => {
      expect(cursorOf(className, true)).toBe("default");
    },
  );

  it("still shows the hand when enabled", () => {
    expect(cursorOf("btn-toolbar", false)).toBe("pointer");
  });
});

// App.css restates the pane minimums as literals, "kept in sync" with
// @shared/layout by comment only — and the window minimum is derived from those
// constants, so a CSS literal drifting upward makes the window draggable narrow
// enough to crush a pane. Computed styles rather than a text match: a later rule
// overriding min-width would beat one that merely appears in the file.
describe("App.css pane minimums match the shared layout", () => {
  function minWidthOf(className: string): number {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const pane = document.createElement("div");
    pane.className = className;
    document.body.appendChild(pane);

    const value = getComputedStyle(pane).minWidth;
    pane.remove();
    style.remove();
    return Number.parseFloat(value);
  }

  it.each([
    ["pane-left", LEFT_MIN],
    ["pane-center", CENTER_MIN],
    ["pane-right", RIGHT_MIN],
  ])("%s uses the shared minimum", (className, expected) => {
    expect(minWidthOf(className)).toBe(expected);
  });
});
