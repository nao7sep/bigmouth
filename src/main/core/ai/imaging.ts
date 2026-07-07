import type { PostFrontMatter } from "../shared/types.js";

export const IMAGING_RELATIONS = ["direct", "domain", "abstract"] as const;
export const IMAGING_MOODS = [
  "bright",
  "calm",
  "neutral",
  "intense",
  "hopeful",
] as const;
export const IMAGING_LITERALNESS = ["literal", "stylized", "symbolic"] as const;
export const IMAGING_PEOPLE = ["people", "mixed", "no-people"] as const;
export const IMAGING_STYLES = [
  "photo",
  "illustration",
  "anime",
  "cinematic",
  "minimal",
] as const;
export const IMAGING_COUNTS = [3, 5, 10] as const;

export type ImagingRelation = (typeof IMAGING_RELATIONS)[number];
export type ImagingMood = (typeof IMAGING_MOODS)[number];
export type ImagingLiteralness = (typeof IMAGING_LITERALNESS)[number];
export type ImagingPeople = (typeof IMAGING_PEOPLE)[number];
export type ImagingStyle = (typeof IMAGING_STYLES)[number];

export type ImagingOptions = {
  count: number;
  relation: ImagingRelation;
  emotionalLens: ImagingMood;
  literalness: ImagingLiteralness;
  people: ImagingPeople;
  style: ImagingStyle;
};

export type ImagingContext = {
  targetName?: string;
  frontMatter?: PostFrontMatter;
};

const RELATION_GUIDANCE: Record<ImagingRelation, string> = {
  direct:
    "Use the post's concrete subject as the visual subject. Keep the scene close to actual people, places, objects, situations, or actions described in the draft.",
  domain:
    "Use the post's broader domain as inspiration. Show a representative scene, environment, or situation that communicates the topic without merely restaging the draft.",
  abstract:
    "Use visual metaphor. Focus on the underlying tension, takeaway, or emotional movement while retaining enough source-specific cues to feel connected to the post.",
};

const MOOD_GUIDANCE: Record<ImagingMood, string> = {
  bright:
    "Use clear, lively, optimistic light and color. Keep it sophisticated, not childish or artificially cheerful.",
  calm:
    "Use a quiet composition, soft light, and restrained emotion. Make the image feel settled and thoughtful.",
  neutral:
    "Use an editorial, observational tone. Avoid exaggerated drama, cuteness, sentimentality, or moralizing.",
  intense:
    "Use visual energy, contrast, or tension while staying credible. Avoid horror, disaster, or melodrama unless the draft clearly calls for it.",
  hopeful:
    "Use a constructive, forward-looking mood with signs of agency, repair, learning, or progress. Do not erase the draft's real stakes.",
};

const LITERALNESS_GUIDANCE: Record<ImagingLiteralness, string> = {
  literal:
    "Create a concrete scene that could plausibly illustrate the post directly.",
  stylized:
    "Use controlled stylization, graphic composition, or cinematic exaggeration while keeping the subject and setting legible.",
  symbolic:
    "Create a symbolic scene or metaphor. Make the symbol understandable without becoming generic or detached from the source.",
};

const PEOPLE_GUIDANCE: Record<ImagingPeople, string> = {
  people:
    "Include one or more people as primary subjects. Use believable gestures, posture, and interaction; avoid posed stock-photo smiles.",
  mixed:
    "Include people only when they improve the concept. They may be secondary, distant, or absent if objects or environments carry the idea better.",
  "no-people":
    "Do not include people, faces, bodies, silhouettes, or crowds. Use objects, environments, traces of activity, or symbolic motifs instead.",
};

const STYLE_GUIDANCE: Record<ImagingStyle, string> = {
  photo:
    "Write for a photorealistic editorial image with natural lens choice, composition, lighting, and texture. Avoid illustration or CGI language.",
  illustration:
    "Write for a polished editorial illustration with clear shapes, purposeful color, and subtle texture. Avoid childish or clip-art language.",
  anime:
    "Write for a contemporary anime key visual with expressive composition, cinematic lighting, and believable environmental details.",
  cinematic:
    "Write for a cinematic still with lens, framing, lighting, atmosphere, and production-design details. Do not make it feel like a poster with text.",
  minimal:
    "Write for a minimal editorial image with few elements, strong negative space, restrained color, and clear symbolism.",
};

export function buildImagingSchema(count: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        minItems: count,
        maxItems: count,
        uniqueItems: true,
        items: {
          type: "string",
          minLength: 20,
          maxLength: 1200,
          description:
            "One standalone English image-generation prompt, directly usable as input to an image model. Include subject, setting, composition, lighting, style, and mood. Do not include numbering, labels, titles, negative prompts, or explanations.",
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  };
}

export function normalizeImagingOutput(raw: unknown, expectedCount: number): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Structured imaging response was not an object");
  }

  const items = (raw as Record<string, unknown>).items;
  if (!Array.isArray(items)) {
    throw new Error("Structured imaging response omitted items[]");
  }

  const normalized = items.map((item) => {
    if (typeof item !== "string") {
      throw new Error("Structured imaging response contained a non-string prompt");
    }
    const prompt = item.trim();
    if (!prompt) {
      throw new Error("Structured imaging response contained an empty prompt");
    }
    return prompt;
  });

  if (normalized.length !== expectedCount) {
    throw new Error(`Structured imaging response returned ${normalized.length} prompts instead of ${expectedCount}`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Structured imaging response contained duplicate prompts");
  }

  return normalized;
}

export function buildImagingSystemPrompt(count: number): string {
  return [
    "Generate image-generation prompts for a post.",
    `Return exactly ${count} prompts.`,
    "- Use the provided JSON schema as the output contract.",
    "- Each item must be one standalone English prompt that can be pasted into an image model.",
    "- Make the prompts materially different concepts, not minor rewrites of the same image.",
    "- Every prompt should specify the subject, setting, composition/framing, lighting, style or medium, mood, and a few concrete visual details.",
    "- Use English only as the prompt language. Do not shift the depicted place, culture, institutions, architecture, clothing, or everyday details away from the source context.",
    "- Use draft content as the primary source. Existing metadata is secondary context for consistency.",
    "- Stay close to what the post actually says or strongly implies. Do not invent claims, events, brands, named people, or locations.",
    "- Reflect the post's overall tone and direction, not only its most alarming or emotional detail.",
    "- Avoid readable text, captions, labels, logos, watermarks, UI text, or exact signage unless the source absolutely requires them.",
    "- Do not include titles, numbering, explanations, parameter syntax, or negative prompts inside the returned prompt strings.",
  ].join("\n");
}

export function buildImagingUserContent(
  content: string,
  options: ImagingOptions,
  context: ImagingContext
): string {
  const sourceMetadata = buildSourceMetadata(context);
  return [
    "<generation_request>",
    JSON.stringify(options, null, 2),
    "</generation_request>",
    "",
    "<source_metadata>",
    JSON.stringify(sourceMetadata, null, 2),
    "</source_metadata>",
    "",
    "<selected_guidance>",
    `relation: ${RELATION_GUIDANCE[options.relation]}`,
    `emotionalLens: ${MOOD_GUIDANCE[options.emotionalLens]}`,
    `literalness: ${LITERALNESS_GUIDANCE[options.literalness]}`,
    `people: ${PEOPLE_GUIDANCE[options.people]}`,
    `style: ${STYLE_GUIDANCE[options.style]}`,
    "</selected_guidance>",
    "",
    "<draft>",
    content,
    "</draft>",
  ].join("\n");
}

function buildSourceMetadata(context: ImagingContext): Record<string, unknown> {
  const frontMatter = context.frontMatter;
  if (!frontMatter) {
    return compactRecord({ target: context.targetName });
  }

  return compactRecord({
    language: frontMatter.language,
    target: frontMatter.target,
    title: frontMatter.title,
    titleEn: frontMatter.titleEn,
    tags: compactTags(frontMatter.tags),
    tagsEn: compactTags(frontMatter.tagsEn),
    metaDescription: frontMatter.metaDescription,
    metaDescriptionEn: frontMatter.metaDescriptionEn,
    extra: frontMatter.extra,
  });
}

function compactRecord(values: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      if (value.length > 0) compact[key] = value;
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) compact[key] = trimmed;
      continue;
    }
    if (value !== undefined && value !== null) compact[key] = value;
  }
  return compact;
}

function compactTags(tags: string[] | undefined): string[] | undefined {
  const compact = tags?.map((tag) => tag.trim()).filter(Boolean);
  return compact && compact.length > 0 ? compact : undefined;
}
