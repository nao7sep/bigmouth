import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CENTER_MIN, LEFT_MIN, RIGHT_MIN } from "@shared/layout";

// Read App.css as text and assert the window-chrome rules are present. These are
// regression guards for the in-page chrome conventions (scroll bars + content-
// based sizing); they catch a refactor that silently drops a rule far more
// cheaply than a rendering test would. (A Vite `?raw` import resolves to empty
// under Vitest's CSS handling, so the file is read from disk instead, resolved
// from the package root where Vitest runs — Node built-ins are typed via
// tests/node-shims.d.ts.)

const css = readFileSync(`${process.cwd()}/src/renderer/src/App.css`, "utf8");

describe("App.css window chrome", () => {
  it("declares a light color-scheme so native UI matches the theme", () => {
    expect(css).toMatch(/color-scheme:\s*light/);
  });

  it("styles the scroll bar thin and rounded instead of the OS default", () => {
    // Both halves of the web rule: the WebKit pseudo-element style and the
    // standards-track scrollbar-width.
    expect(css).toMatch(/::-webkit-scrollbar\b/);
    expect(css).toMatch(/scrollbar-width:\s*thin/);
    // A rounded (pill) thumb inset via a transparent border + padding-box clip.
    expect(css).toMatch(/::-webkit-scrollbar-thumb[\s\S]*?border-radius/);
  });

  it("gives the center pane a non-zero minimum width (no min-width: 0)", () => {
    const block = css.match(/\.pane-center\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(block).not.toMatch(/min-width:\s*0\b/);
    const min = block.match(/min-width:\s*(\d+)px/);
    expect(min).not.toBeNull();
    expect(Number(min![1])).toBeGreaterThan(0);
  });

  it("lets the pane row scroll horizontally rather than collapsing a pane", () => {
    const block = css.match(/\.app-layout\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(block).toMatch(/overflow-x:\s*auto/);
  });
});

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
