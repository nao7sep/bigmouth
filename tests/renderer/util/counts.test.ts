import { describe, it, expect } from "vitest";
import {
  graphemeCount,
  xWeightedCount,
  extractParagraphs,
  computeCounts,
} from "@renderer/util/counts";

describe("graphemeCount", () => {
  it("counts ASCII characters", () => {
    expect(graphemeCount("hello")).toBe(5);
  });

  it("counts an emoji with a ZWJ sequence as one grapheme", () => {
    // Family emoji (man+woman+girl+boy joined) is a single grapheme cluster.
    expect(graphemeCount("👨\u200D👩\u200D👧\u200D👦")).toBe(1);
  });

  it("returns 0 for empty string", () => {
    expect(graphemeCount("")).toBe(0);
  });
});

describe("xWeightedCount", () => {
  it("weights ASCII at 1 per character", () => {
    expect(xWeightedCount("hello world")).toBe(11);
  });

  it("weights CJK heavier than ASCII", () => {
    // Twitter counts most CJK at 2 per character.
    expect(xWeightedCount("日本語")).toBeGreaterThan(3);
  });
});

describe("extractParagraphs", () => {
  it("keeps prose paragraphs separated by blank lines", () => {
    expect(extractParagraphs("First para.\n\nSecond para.")).toEqual([
      "First para.",
      "Second para.",
    ]);
  });

  it("joins consecutive prose lines into one paragraph", () => {
    expect(extractParagraphs("line one\nline two")).toEqual([
      "line one line two",
    ]);
  });

  it("excludes fenced code blocks", () => {
    const md = "before\n\n```\ncode line\n```\n\nafter";
    expect(extractParagraphs(md)).toEqual(["before", "after"]);
  });

  it.each([
    ["ATX heading", "# Heading"],
    ["unordered list", "- item"],
    ["ordered list", "1. item"],
    ["table row", "| a | b |"],
    ["horizontal rule", "---"],
    ["blockquote", "> quote"],
    ["standalone image", "![alt](img.png)"],
    ["link reference def", "[id]: https://example.com"],
    ["inline HTML", "<div>x</div>"],
  ])("excludes %s", (_label, line) => {
    expect(extractParagraphs(line)).toEqual([]);
  });

  it("returns no paragraphs for empty or whitespace input", () => {
    expect(extractParagraphs("")).toEqual([]);
    expect(extractParagraphs("\n\n  \n")).toEqual([]);
  });

  it("isolates prose around non-prose lines", () => {
    const md = "intro\n# Heading\nbody text\n- a list item\nmore body";
    expect(extractParagraphs(md)).toEqual(["intro", "body text", "more body"]);
  });
});

describe("computeCounts", () => {
  it("computes paragraph statistics", () => {
    const counts = computeCounts("aaaa\n\nbb");
    expect(counts.paragraphs).toBe(2);
    expect(counts.longestParagraphLength).toBe(4);
    expect(counts.avgParagraphLength).toBe(3); // round((4 + 2) / 2)
  });

  it("returns zeroed paragraph stats for prose-free input", () => {
    const counts = computeCounts("# Only a heading");
    expect(counts.paragraphs).toBe(0);
    expect(counts.avgParagraphLength).toBe(0);
    expect(counts.longestParagraphLength).toBe(0);
  });
});

// A fence closes only on a run of the SAME character, at least as long as the one
// that opened it. Toggling on either marker meant a `~~~` inside a ``` block
// ended it and everything after was counted as prose - which a post ABOUT
// Markdown will contain as a matter of course.
describe("code fences", () => {
  it("is not closed by the other fence character", () => {
    expect(extractParagraphs("before\n\n```\nx\n~~~\ny\n```\n\nafter")).toEqual([
      "before",
      "after",
    ]);
  });

  it("is not closed by a shorter run of its own character", () => {
    expect(extractParagraphs("before\n\n````\n```\ncode\n````\n\nafter")).toEqual([
      "before",
      "after",
    ]);
  });

  it("closes on a longer run of its own character", () => {
    expect(extractParagraphs("before\n\n```\ncode\n`````\n\nafter")).toEqual(["before", "after"]);
  });
});

describe("setext underlines", () => {
  it("excludes an underline of any length, not just three or more", () => {
    // CommonMark allows a single `=`, and it was counted as prose.
    expect(extractParagraphs("Title\n==\n\nbody")).toEqual(["Title", "body"]);
    expect(extractParagraphs("Title\n=\n\nbody")).toEqual(["Title", "body"]);
  });
});
