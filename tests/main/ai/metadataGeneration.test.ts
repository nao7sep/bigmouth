import { describe, it, expect } from "vitest";
import {
  isMetadataField,
  normalizeMetadataFields,
  buildMetadataSchema,
  buildMetadataGenerationRequest,
  normalizeGeneratedMetadata,
  metadataValueToClientString,
  type MetadataField,
} from "@main/core/ai/metadataGeneration.js";
import type { PostFrontMatter } from "@main/core/shared/types.js";

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

/** The JSON the request wraps in <metadata_request>, for asserting on its keys. */
function payloadOf(userContent: string): string {
  const match = /<metadata_request>\n([\s\S]*?)\n<\/metadata_request>/.exec(userContent);
  if (!match) throw new Error("userContent carried no <metadata_request> block");
  return match[1];
}

describe("buildMetadataGenerationRequest", () => {
  it("embeds requested fields, existing metadata, and the draft body", () => {
    const req = buildMetadataGenerationRequest({
      fields: ["title", "slug"],
      content: "The draft body.",
      frontMatter: frontMatter({ metaDescription: "既存の説明文", tags: ["a", "b"] }),
      customPrompts: {},
    });

    // System prompt carries per-field guidance headers.
    expect(req.systemPrompt).toContain("(title)");
    expect(req.systemPrompt).toContain("(slug)");

    // User content wraps the draft and a metadata request payload.
    expect(req.userContent).toContain("<draft>");
    expect(req.userContent).toContain("The draft body.");
    // The payload names the fields being asked for, not only the schema.
    expect(JSON.parse(payloadOf(req.userContent)).fieldsToGenerate).toEqual(["title", "slug"]);
    expect(req.userContent).toContain('"draftLanguage": "ja"');
    // A field this request is not regenerating stays available as context.
    expect(req.userContent).toContain("既存の説明文");

    expect(req.schema.required).toEqual(["title", "slug"]);
  });

  // A Japanese draft, Japanese existing metadata and a "stay consistent"
  // instruction all argue for answering an English field in Japanese. The
  // counter-rule has to be in the app's own prompt, because per-field guidance
  // is user-editable — the one place that said "English" was the one place a
  // user could delete it.
  it("states the output-language rule over every field, ahead of the field guidance", () => {
    const req = buildMetadataGenerationRequest({
      fields: ["titleEn"],
      content: "body",
      frontMatter: frontMatter(),
      customPrompts: { titleEn: "MY CUSTOM GUIDANCE WITH NO MENTION OF LANGUAGE" },
    });

    expect(req.systemPrompt).toContain("titleEn, slug, tagsEn and metaDescriptionEn");
    expect(req.systemPrompt).toContain("title, tags and metaDescription");
    expect(req.systemPrompt).toContain("never selects the output language");
    expect(req.systemPrompt.indexOf("Output language:")).toBeLessThan(
      req.systemPrompt.indexOf("Field-specific guidance:")
    );
  });

  // `language: "ja"` beside `fieldsToGenerate: ["titleEn"]` reads as the
  // language to answer in, which is what it was doing.
  it("names the draft's language as context rather than as a language to answer in", () => {
    const req = buildMetadataGenerationRequest({
      fields: ["titleEn"],
      content: "body",
      frontMatter: frontMatter(),
      customPrompts: {},
    });

    expect(req.userContent).toContain('"draftLanguage": "ja"');
    expect(req.userContent).not.toContain('"language": "ja"');
  });

  // Regenerating a field used to hand the model that field's own last answer as
  // the thing to stay consistent with, so a value that came back in the wrong
  // language reproduced itself on every retry.
  it("withholds a regenerated field's own previous value from the existing metadata", () => {
    const req = buildMetadataGenerationRequest({
      fields: ["titleEn"],
      content: "The draft body.",
      frontMatter: frontMatter({ titleEn: "誤って日本語になった値", title: "既存タイトル" }),
      customPrompts: {},
    });

    const existing = JSON.parse(payloadOf(req.userContent)).existingMetadata;
    expect(existing).not.toHaveProperty("titleEn");
    // Fields that are not being regenerated remain context.
    expect(existing.title).toBe("既存タイトル");
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

  // Until this check existed, only the slug's URL-safe pattern held any field to
  // a script, so an English field returned in the draft's language was written
  // into the post's front matter and the author was the only detector.
  it("rejects an English field returned in the draft's language", () => {
    expect(() =>
      normalizeGeneratedMetadata({ titleEn: "日本語のタイトルです" }, ["titleEn"])
    ).toThrow(/instead of English/i);

    expect(() =>
      normalizeGeneratedMetadata(
        { metaDescriptionEn: "この記事は日本語で書かれた説明文で、英語ではありません。" },
        ["metaDescriptionEn"]
      )
    ).toThrow(/instead of English/i);
  });

  it("accepts an English field carrying a name in its own script", () => {
    const normalized = normalizeGeneratedMetadata(
      { titleEn: "What 鬼滅の刃 gets right about pacing" },
      ["titleEn"]
    );
    expect(normalized.titleEn).toBe("What 鬼滅の刃 gets right about pacing");
  });

  // Tags are judged as one set, so a single proper noun does not fail the batch
  // while a set that came back wholly in the wrong language still does.
  it("judges English tags together rather than one by one", () => {
    const normalized = normalizeGeneratedMetadata(
      { tagsEn: ["pacing", "anime", "鬼滅の刃", "storytelling", "craft"] },
      ["tagsEn"]
    );
    expect(normalized.tagsEn).toContain("鬼滅の刃");

    expect(() =>
      normalizeGeneratedMetadata(
        { tagsEn: ["物語", "演出", "作画", "構成", "演技"] },
        ["tagsEn"]
      )
    ).toThrow(/instead of English/i);
  });

  it("leaves draft-language fields alone", () => {
    const normalized = normalizeGeneratedMetadata(
      { title: "日本語のタイトルです", tags: ["物語", "演出", "作画", "構成", "演技"] },
      ["title", "tags"]
    );
    expect(normalized.title).toBe("日本語のタイトルです");
  });
});

describe("metadataValueToClientString", () => {
  it("joins arrays with commas and passes strings through", () => {
    expect(metadataValueToClientString(["a", "b", "c"])).toBe("a, b, c");
    expect(metadataValueToClientString("plain")).toBe("plain");
  });
});
