import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

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
