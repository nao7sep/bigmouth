import { describe, it, expect } from "vitest";
import {
  isMetadataField,
  normalizeMetadataFields,
  buildMetadataSchema,
  buildMetadataGenerationRequest,
  normalizeGeneratedMetadata,
  metadataValueToClientString,
  type MetadataField,
} from "./metadataGeneration.js";
import type { PostFrontMatter } from "../shared/types.js";

function frontMatter(overrides: Partial<PostFrontMatter> = {}): PostFrontMatter {
  return {
    id: "abc123",
    target: "blogger",
    status: "draft",
    language: "ja",
    createdAtUtc: "2026-04-05T14:30:22Z",
    updatedAtUtc: "2026-04-05T14:30:22Z",
    ...overrides,
  };
}

describe("isMetadataField", () => {
  it("accepts known fields and rejects others", () => {
    expect(isMetadataField("title")).toBe(true);
    expect(isMetadataField("slug")).toBe(true);
    expect(isMetadataField("id")).toBe(false);
  });
});

describe("normalizeMetadataFields", () => {
  it("drops unknown fields and de-duplicates while preserving order", () => {
    expect(
      normalizeMetadataFields(["title", "bogus", "slug", "title"])
    ).toEqual(["title", "slug"]);
  });
});

describe("buildMetadataSchema", () => {
  it("builds an object schema requiring exactly the requested fields", () => {
    const schema = buildMetadataSchema(["title", "slug"]);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["title", "slug"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties as object)).toEqual(["title", "slug"]);
  });
});

describe("buildMetadataGenerationRequest", () => {
  it("embeds requested fields, existing metadata, and the draft body", () => {
    const req = buildMetadataGenerationRequest({
      fields: ["title", "slug"],
      content: "The draft body.",
      frontMatter: frontMatter({ title: "既存タイトル", tags: ["a", "b"] }),
      customPrompts: {},
    });

    // System prompt carries per-field guidance headers.
    expect(req.systemPrompt).toContain("(title)");
    expect(req.systemPrompt).toContain("(slug)");

    // User content wraps the draft and a metadata request payload.
    expect(req.userContent).toContain("<draft>");
    expect(req.userContent).toContain("The draft body.");
    expect(req.userContent).toContain('"language": "ja"');
    expect(req.userContent).toContain("既存タイトル");

    expect(req.schema.required).toEqual(["title", "slug"]);
  });

  it("uses a custom field prompt when supplied", () => {
    const req = buildMetadataGenerationRequest({
      fields: ["title"],
      content: "body",
      frontMatter: frontMatter(),
      customPrompts: { title: "MY CUSTOM TITLE GUIDANCE" },
    });
    expect(req.systemPrompt).toContain("MY CUSTOM TITLE GUIDANCE");
  });
});

describe("normalizeGeneratedMetadata", () => {
  const fields: MetadataField[] = ["title", "slug", "tags"];

  it("normalizes a valid response", () => {
    const result = normalizeGeneratedMetadata(
      {
        title: "  Hello  ",
        slug: "hello-world",
        tags: ["one", "two", "three", "four", "five"],
      },
      fields
    );
    expect(result).toEqual({
      title: "Hello",
      slug: "hello-world",
      tags: ["one", "two", "three", "four", "five"],
    });
  });

  it("throws when the response is not an object", () => {
    expect(() => normalizeGeneratedMetadata("nope", fields)).toThrow();
  });

  it("throws on unexpected extra fields", () => {
    expect(() =>
      normalizeGeneratedMetadata(
        { title: "t", slug: "s", tags: ["a", "b", "c", "d", "e"], extra: "x" },
        fields
      )
    ).toThrow(/unexpected/i);
  });

  it("throws when a requested field is omitted", () => {
    expect(() =>
      normalizeGeneratedMetadata({ title: "t", slug: "s" }, fields)
    ).toThrow(/omitted/i);
  });

  it("rejects a non-URL-safe slug", () => {
    expect(() =>
      normalizeGeneratedMetadata(
        { title: "t", slug: "Not A Slug", tags: ["a", "b", "c", "d", "e"] },
        fields
      )
    ).toThrow(/url-safe/i);
  });

  it("rejects a tag list outside the 5-8 range", () => {
    expect(() =>
      normalizeGeneratedMetadata(
        { title: "t", slug: "s", tags: ["a", "b"] },
        fields
      )
    ).toThrow(/5 to 8/);
  });

  it("de-duplicates tags before counting", () => {
    expect(() =>
      normalizeGeneratedMetadata(
        // 6 entries collapse to 4 unique -> below the minimum.
        { title: "t", slug: "s", tags: ["a", "a", "b", "b", "c", "d"] },
        fields
      )
    ).toThrow(/5 to 8/);
  });
});

describe("metadataValueToClientString", () => {
  it("joins arrays with commas and passes strings through", () => {
    expect(metadataValueToClientString(["a", "b", "c"])).toBe("a, b, c");
    expect(metadataValueToClientString("plain")).toBe("plain");
  });
});
