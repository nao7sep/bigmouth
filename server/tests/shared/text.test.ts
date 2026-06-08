import { describe, it, expect } from "vitest";
import { minifyExcerpt } from "../../src/../src/shared/text.js";

describe("minifyExcerpt", () => {
  it("collapses every whitespace run (including newlines and tabs) to one space", () => {
    expect(minifyExcerpt("a\n\n  b\tc")).toBe("a b c");
  });

  it("trims leading and trailing whitespace", () => {
    expect(minifyExcerpt("   hello world   ")).toBe("hello world");
  });

  it("skips blank lines without leaving double spaces", () => {
    expect(minifyExcerpt("first\n\n\nsecond")).toBe("first second");
  });

  it("stops once maxChars code points are reached", () => {
    expect(minifyExcerpt("abcdef", 3)).toBe("abc");
  });

  it("counts the collapsed separator toward maxChars", () => {
    expect(minifyExcerpt("ab cd", 4)).toBe("ab c");
  });

  it("never splits a surrogate pair (counts by code point)", () => {
    const out = minifyExcerpt("😀😀😀", 2);
    expect(out).toBe("😀😀");
    expect([...out]).toHaveLength(2);
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    expect(minifyExcerpt("")).toBe("");
    expect(minifyExcerpt("   \n\t  ")).toBe("");
  });

  it("returns an empty string when maxChars is zero", () => {
    expect(minifyExcerpt("anything", 0)).toBe("");
  });

  it("does not strip Markdown markers — it is a faithful preview", () => {
    expect(minifyExcerpt("# Heading\n\nbody")).toBe("# Heading body");
  });
});
