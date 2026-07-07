// Pure-function tests for the imaging prompt builders. No mocks: these assert
// that the system prompt, user content, and schema carry the option-driven
// fragments each option dimension contributes, plus the normalization rules.

import { describe, it, expect } from "vitest";
import {
  buildImagingSchema,
  buildImagingSystemPrompt,
  buildImagingUserContent,
  normalizeImagingOutput,
  IMAGING_COUNTS,
  IMAGING_RELATIONS,
  IMAGING_MOODS,
  IMAGING_LITERALNESS,
  IMAGING_PEOPLE,
  IMAGING_STYLES,
  type ImagingOptions,
} from "@main/core/ai/imaging.js";
import type { PostFrontMatter } from "@main/core/shared/types.js";

function options(overrides: Partial<ImagingOptions> = {}): ImagingOptions {
  return {
    count: 5,
    relation: "direct",
    emotionalLens: "calm",
    literalness: "literal",
    people: "no-people",
    style: "photo",
    ...overrides,
  };
}

describe("buildImagingSystemPrompt", () => {
  it("states the exact requested prompt count", () => {
    for (const count of IMAGING_COUNTS) {
      const prompt = buildImagingSystemPrompt(count);
      expect(prompt).toContain(`Return exactly ${count} prompts.`);
    }
  });

  it("includes the standalone-English-prompt contract", () => {
    const prompt = buildImagingSystemPrompt(3);
    expect(prompt).toContain("Use the provided JSON schema as the output contract.");
    expect(prompt).toContain("one standalone English prompt");
    expect(prompt).toContain("Use draft content as the primary source.");
  });
});

describe("buildImagingUserContent — option-driven guidance fragments", () => {
  const context = { targetName: "blogger" };

  it("serializes the full options object inside <generation_request>", () => {
    const opts = options({ count: 10, relation: "abstract", style: "anime" });
    const content = buildImagingUserContent("draft body", opts, context);
    expect(content).toContain("<generation_request>");
    expect(content).toContain('"count": 10');
    expect(content).toContain('"relation": "abstract"');
    expect(content).toContain('"style": "anime"');
  });

  it("emits relation guidance keyed to the selected relation", () => {
    const direct = buildImagingUserContent("d", options({ relation: "direct" }), context);
    expect(direct).toContain("relation: Use the post's concrete subject");

    const domain = buildImagingUserContent("d", options({ relation: "domain" }), context);
    expect(domain).toContain("relation: Use the post's broader domain as inspiration.");

    const abstract = buildImagingUserContent("d", options({ relation: "abstract" }), context);
    expect(abstract).toContain("relation: Use visual metaphor.");
  });

  it("emits emotionalLens (mood) guidance keyed to the selected mood", () => {
    const expectations: Record<(typeof IMAGING_MOODS)[number], string> = {
      bright: "emotionalLens: Use clear, lively, optimistic light",
      calm: "emotionalLens: Use a quiet composition",
      neutral: "emotionalLens: Use an editorial, observational tone.",
      intense: "emotionalLens: Use visual energy, contrast, or tension",
      hopeful: "emotionalLens: Use a constructive, forward-looking mood",
    };
    for (const mood of IMAGING_MOODS) {
      const content = buildImagingUserContent("d", options({ emotionalLens: mood }), context);
      expect(content).toContain(expectations[mood]);
    }
  });

  it("emits literalness guidance keyed to the selected literalness", () => {
    const expectations: Record<(typeof IMAGING_LITERALNESS)[number], string> = {
      literal: "literalness: Create a concrete scene",
      stylized: "literalness: Use controlled stylization",
      symbolic: "literalness: Create a symbolic scene or metaphor.",
    };
    for (const literalness of IMAGING_LITERALNESS) {
      const content = buildImagingUserContent("d", options({ literalness }), context);
      expect(content).toContain(expectations[literalness]);
    }
  });

  it("emits people guidance keyed to the selected people option", () => {
    const expectations: Record<(typeof IMAGING_PEOPLE)[number], string> = {
      people: "people: Include one or more people as primary subjects.",
      mixed: "people: Include people only when they improve the concept.",
      "no-people": "people: Do not include people, faces, bodies",
    };
    for (const people of IMAGING_PEOPLE) {
      const content = buildImagingUserContent("d", options({ people }), context);
      expect(content).toContain(expectations[people]);
    }
  });

  it("emits style guidance keyed to the selected style", () => {
    const expectations: Record<(typeof IMAGING_STYLES)[number], string> = {
      photo: "style: Write for a photorealistic editorial image",
      illustration: "style: Write for a polished editorial illustration",
      anime: "style: Write for a contemporary anime key visual",
      cinematic: "style: Write for a cinematic still",
      minimal: "style: Write for a minimal editorial image",
    };
    for (const style of IMAGING_STYLES) {
      const content = buildImagingUserContent("d", options({ style }), context);
      expect(content).toContain(expectations[style]);
    }
  });

  it("covers every relation option dimension explicitly", () => {
    for (const relation of IMAGING_RELATIONS) {
      const content = buildImagingUserContent("d", options({ relation }), context);
      expect(content).toContain(`relation: `);
      expect(content).toContain(`"relation": "${relation}"`);
    }
  });

  it("embeds the draft body inside the <draft> block", () => {
    const content = buildImagingUserContent("My specific draft text.", options(), context);
    expect(content).toContain("<draft>");
    expect(content).toContain("My specific draft text.");
    expect(content).toContain("</draft>");
  });

  it("uses the target name as source metadata when no front matter is given", () => {
    const content = buildImagingUserContent("d", options(), { targetName: "journal" });
    expect(content).toContain("<source_metadata>");
    expect(content).toContain('"target": "journal"');
  });

  it("derives compacted source metadata from front matter, dropping empty fields", () => {
    const frontMatter: PostFrontMatter = {
      id: "p1",
      target: "blogger",
      status: "draft",
      language: "ja",
      title: "  Spaced Title  ",
      titleEn: "",
      tags: ["one", "  ", "two"],
      metaDescription: "A description.",
      createdAtUtc: "x",
      updatedAtUtc: "x",
    };
    const content = buildImagingUserContent("d", options(), { frontMatter });
    expect(content).toContain('"language": "ja"');
    expect(content).toContain('"title": "Spaced Title"'); // trimmed
    expect(content).toContain('"metaDescription": "A description."');
    expect(content).toContain('"one"');
    expect(content).toContain('"two"');
    expect(content).not.toContain('"titleEn"'); // empty string dropped
  });
});

describe("buildImagingSchema", () => {
  it("bounds the items array to the requested count", () => {
    for (const count of IMAGING_COUNTS) {
      const schema = buildImagingSchema(count) as {
        properties: { items: { minItems: number; maxItems: number; uniqueItems: boolean } };
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.properties.items.minItems).toBe(count);
      expect(schema.properties.items.maxItems).toBe(count);
      expect(schema.properties.items.uniqueItems).toBe(true);
      expect(schema.required).toEqual(["items"]);
      expect(schema.additionalProperties).toBe(false);
    }
  });
});

describe("normalizeImagingOutput", () => {
  it("trims and returns the expected number of distinct prompts", () => {
    const out = normalizeImagingOutput({ items: ["  a  ", "b", "c"] }, 3);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("throws when the response is not an object", () => {
    expect(() => normalizeImagingOutput(["a", "b", "c"], 3)).toThrow(/was not an object/);
    expect(() => normalizeImagingOutput(null, 3)).toThrow(/was not an object/);
  });

  it("throws when items[] is missing", () => {
    expect(() => normalizeImagingOutput({ notItems: [] }, 3)).toThrow(/omitted items/);
  });

  it("throws on a non-string prompt", () => {
    expect(() => normalizeImagingOutput({ items: ["a", 2, "c"] }, 3)).toThrow(/non-string prompt/);
  });

  it("throws on an empty prompt", () => {
    expect(() => normalizeImagingOutput({ items: ["a", "   ", "c"] }, 3)).toThrow(/empty prompt/);
  });

  it("throws when the count does not match", () => {
    expect(() => normalizeImagingOutput({ items: ["a", "b"] }, 3)).toThrow(/2 prompts instead of 3/);
  });

  it("throws on duplicate prompts", () => {
    expect(() => normalizeImagingOutput({ items: ["a", "a", "c"] }, 3)).toThrow(/duplicate prompts/);
  });
});
