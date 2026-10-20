import { describe, it, expect } from "vitest";
import { editorHighlightStyle } from "@renderer/components/editorHighlight";
import { themeTokens } from "../../appStylesheet";

// Every syntax color reads a palette token that both themes define, so the
// editor never shows a fixed color that only one theme can carry. Each token's
// contrast against the editor surface is checked with the rest of the palette.

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
      expect(themeTokens.light.has(token), `${token} in light`).toBe(true);
      expect(themeTokens.dark.has(token), `${token} in dark`).toBe(true);
    }
  });
});
