import { describe, it, expect } from "vitest";
import { multiline, truncate } from "../../src/../src/shared/textCleanup.js";

// Options the server uses for Markdown post bodies: keep trailing whitespace (a
// two-space hard line break), drop only edge blank lines, keep interior blanks.
const MD = { trimLineEnds: false, dropEdgeBlankLines: true, collapseBlankLines: false } as const;

describe("multiline (Markdown body options)", () => {
  it("preserves trailing spaces so a Markdown hard line break survives", () => {
    expect(multiline("a  \nb  ", MD)).toBe("a  \nb  ");
  });

  it("drops blank lines at the edges while keeping the first line's indentation", () => {
    expect(multiline("\n\n  hello\n\n", MD)).toBe("  hello");
  });

  it("treats a whitespace-only line as blank at the edges", () => {
    expect(multiline("   \n\t\ncontent", MD)).toBe("content");
  });

  it("preserves interior blank runs as authorial section breaks", () => {
    expect(multiline("a\n\n\nb", MD)).toBe("a\n\n\nb");
  });

  it("normalizes CRLF and lone CR to LF", () => {
    expect(multiline("a\r\nb\rc", MD)).toBe("a\nb\nc");
  });

  it("returns empty for an all-blank body", () => {
    expect(multiline("\n   \n\t\n", MD)).toBe("");
  });

  it("preserves indentation on every line", () => {
    expect(multiline("  one\n    two", MD)).toBe("  one\n    two");
  });
});

describe("multiline (default options)", () => {
  it("trims line ends by default", () => {
    expect(multiline("a  \nb  ")).toBe("a\nb");
  });

  it("collapses interior blank runs only when asked", () => {
    expect(multiline("a\n\n\nb", { collapseBlankLines: true })).toBe("a\n\nb");
  });
});

describe("truncate", () => {
  it("cuts to a minimum length and reports the cut", () => {
    expect(truncate("hello world", 5)).toEqual({ text: "hello", truncated: true });
  });

  it("collapses whitespace runs (including newlines) into single spaces", () => {
    expect(truncate("first\n\n\nsecond", 100)).toEqual({ text: "first second", truncated: false });
  });

  it("does not report a cut when only trailing whitespace follows", () => {
    expect(truncate("hello   ", 5)).toEqual({ text: "hello", truncated: false });
  });

  it("never reports a cut for an all-whitespace tail past the budget", () => {
    expect(truncate("hello \n \t ", 5)).toEqual({ text: "hello", truncated: false });
  });

  it("counts an inserted separator space toward the budget", () => {
    expect(truncate("one two three", 5)).toEqual({ text: "one t", truncated: true });
  });

  it("never splits a surrogate-pair emoji", () => {
    expect(truncate("\u{1F600}x", 1)).toEqual({ text: "\u{1F600}", truncated: true });
  });

  it("never splits a ZWJ family emoji", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const result = truncate(family + "x", 1);
    expect(result).toEqual({ text: family, truncated: true });
    expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(result.text)]).toHaveLength(1);
  });

  it("returns an empty, not-truncated result for n <= 0", () => {
    expect(truncate("anything", 0)).toEqual({ text: "", truncated: false });
  });

  it("returns an empty, not-truncated result for whitespace-only input", () => {
    expect(truncate("   \n\t  ", 5)).toEqual({ text: "", truncated: false });
  });
});
