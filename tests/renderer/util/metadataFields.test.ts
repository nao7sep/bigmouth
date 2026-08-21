import { describe, it, expect } from "vitest";

import { extractFields, parseFieldValue } from "@renderer/util/metadataFields";
import type { PostFrontMatter } from "@shared/types";

function fm(over: Partial<PostFrontMatter> = {}): PostFrontMatter {
  return {
    id: "p1",
    target: "blog",
    status: "draft",
    language: "ja",
    createdAtUtc: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("parseFieldValue", () => {
  it("splits tags on ASCII and ideographic commas, trimming and dropping empties", () => {
    expect(parseFieldValue("tags", "a, b、 c ,,")).toEqual(["a", "b", "c"]);
    expect(parseFieldValue("tagsEn", "x、y")).toEqual(["x", "y"]);
    expect(parseFieldValue("tags", "   ")).toEqual([]);
  });

  it("collapses single-line fields to a single line", () => {
    const result = parseFieldValue("title", "line one\nline two");
    expect(typeof result).toBe("string");
    expect(result).not.toContain("\n");
  });

  it("passes slug and free-text extra through unchanged", () => {
    expect(parseFieldValue("slug", "my-slug")).toBe("my-slug");
    expect(parseFieldValue("extra", "k: v\nx: y")).toBe("k: v\nx: y");
  });
});

describe("extractFields", () => {
  it("joins array values with ', ' and defaults missing fields to ''", () => {
    const fields = extractFields(fm({ title: "T", tags: ["a", "b"] }));
    expect(fields.title).toBe("T");
    expect(fields.tags).toBe("a, b");
    expect(fields.slug).toBe("");
    expect(fields.metaDescription).toBe("");
  });

  it("includes the English companion fields only for non-English posts", () => {
    const ja = extractFields(fm({ language: "ja", titleEn: "EN", tagsEn: ["x", "y"] }));
    expect(ja.titleEn).toBe("EN");
    expect(ja.tagsEn).toBe("x, y");

    const en = extractFields(fm({ language: "en", titleEn: "EN" }));
    expect("titleEn" in en).toBe(false);
    expect("tagsEn" in en).toBe(false);
    expect("metaDescriptionEn" in en).toBe(false);
  });
});

// Zero-width characters are deliberately not whitespace to the cleanup helpers -
// the conventions say so, and ZWJ is structural inside emoji - so this is the
// "separate, explicit step" they reserve. Both cases arrive by an ordinary paste
// from a web page.
describe("a value with nothing visible in it", () => {
  const ZWSP = "\u200b";

  it("commits a zero-width-only title as empty, not as a blank row in the list", () => {
    expect(parseFieldValue("title", ZWSP)).toBe("");
    expect(parseFieldValue("title", `${ZWSP}  ${ZWSP}`)).toBe("");
  });

  it("drops a zero-width-only tag instead of storing an invisible one", () => {
    expect(parseFieldValue("tags", `alpha, ${ZWSP}, beta`)).toEqual(["alpha", "beta"]);
    expect(parseFieldValue("tags", ZWSP)).toEqual([]);
  });

  it("never strips the characters from a value that has other content", () => {
    // ZWJ holds a family emoji together; removing it would split one glyph into
    // four. This decides presence, it does not scrub.
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
    expect(parseFieldValue("title", family)).toBe(family);
    expect(parseFieldValue("tags", family)).toEqual([family]);
  });
});
