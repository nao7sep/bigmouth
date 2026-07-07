import { describe, it, expect } from "vitest";
import { singleLine } from "@renderer/util/textCleanup";

describe("singleLine", () => {
  it("trims leading and trailing whitespace", () => {
    expect(singleLine("  hello  ")).toBe("hello");
  });

  it("flattens a pasted line break into one space by default", () => {
    expect(singleLine("a\nb")).toBe("a b");
  });

  it("collapses a mixed break run (blank lines and spaces) into one space", () => {
    expect(singleLine("aaa\n \n\nbbb")).toBe("aaa bbb");
  });

  it("preserves horizontal spacing typed within a line by default", () => {
    expect(singleLine("a    b")).toBe("a    b");
  });

  it("keeps a lone full-width space by default (no line break to flatten)", () => {
    expect(singleLine("a　b")).toBe("a　b");
  });

  it("returns empty for whitespace-only input", () => {
    expect(singleLine("\n\n  \n")).toBe("");
  });

  it("with flattenLineBreaks off, trims only and keeps interior line breaks", () => {
    expect(singleLine("  a\nb  ", { flattenLineBreaks: false })).toBe("a\nb");
  });

  it("with minify on, collapses every whitespace run including full-width", () => {
    expect(singleLine("a　　b", { minify: true })).toBe("a b");
    expect(singleLine("a    b", { minify: true })).toBe("a b");
  });
});
