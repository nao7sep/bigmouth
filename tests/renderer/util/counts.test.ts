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
    expect(graphemeCount("👨‍👩‍👧‍👦")).toBe(1);
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
