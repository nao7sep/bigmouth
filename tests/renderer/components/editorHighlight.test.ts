import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { editorHighlightStyle } from "@renderer/components/editorHighlight";

// Every syntax color reads a palette token that both themes define, so the
// editor never shows a fixed color that only one theme can carry. The token
// contrast itself is checked in themeContrast.test.ts.
const css = readFileSync(`${process.cwd()}/src/renderer/src/App.css`, "utf8");
const darkBlock = css.slice(css.indexOf("@media (prefers-color-scheme: dark) {"));
const lightBlock = css.slice(css.search(/^:root\s*\{/m), css.indexOf("@media (prefers-color-scheme: dark) {"));

describe("editorHighlightStyle", () => {
  const colors = editorHighlightStyle.specs
    .map((spec) => spec.color)
    .filter((color): color is string => typeof color === "string");

  it("draws every color from a --bm-syntax token", () => {
    expect(colors.length).toBeGreaterThan(10);
    for (const color of colors) expect(color).toMatch(/^var\(--bm-syntax-[a-z]+\)$/);
  });

  it("uses only tokens defined in both themes", () => {
    for (const color of colors) {
      const token = color.slice(4, -1);
      expect(lightBlock, `${token} in light`).toContain(`${token}:`);
      expect(darkBlock, `${token} in dark`).toContain(`${token}:`);
    }
  });
});
