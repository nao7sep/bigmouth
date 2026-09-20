import type { PostFrontMatter } from "../shared/types.js";
import { isEnglishScript } from "./englishText.js";
import { DEFAULT_GENERATION_PROMPTS, systemPromptForField } from "./generationPrompts.js";
import {
  ENGLISH_METADATA_FIELDS,
  GENERATED_SLUG,
  GENERATED_SLUG_MAX_LENGTH,
  GENERATED_SLUG_PATTERN,
  GENERATION_PROMPT_KEYS,
  isMetadataField,
  type MetadataField,
} from "@shared/metadataFields";

export type { MetadataField };
export { isMetadataField };
export type GeneratedMetadataValue = string | string[];
export type GeneratedMetadata = Partial<Record<MetadataField, GeneratedMetadataValue>>;

const FIELD_LABELS: Record<MetadataField, string> = {
  title: "Title",
  titleEn: "English title",
  slug: "English URL slug",
  tags: "Native-language tags",
  tagsEn: "English tags",
  metaDescription: "Native-language meta description",
  metaDescriptionEn: "English meta description",
};

const FIELD_SCHEMAS: Record<MetadataField, Record<string, unknown>> = {
  title: {
    type: "string",
    minLength: 1,
    maxLength: 140,
    description: "A concise title in the same language as the draft.",
  },
  titleEn: {
    type: "string",
    minLength: 1,
    maxLength: 140,
    description: "A concise English title for the draft.",
  },
  slug: {
    type: "string",
    minLength: 1,
    maxLength: GENERATED_SLUG_MAX_LENGTH,
    pattern: GENERATED_SLUG_PATTERN,
    description: "A short readable English slug using lowercase letters, numbers, and hyphens only.",
  },
  tags: {
    type: "array",
    minItems: 5,
    maxItems: 8,
    uniqueItems: true,
    items: {
      type: "string",
      minLength: 1,
      maxLength: 40,
    },
    description: "Five to eight short searchable topic tags in the same language as the draft.",
  },
  tagsEn: {
    type: "array",
    minItems: 5,
    maxItems: 8,
    uniqueItems: true,
    items: {
      type: "string",
      minLength: 1,
      maxLength: 40,
    },
    description: "Five to eight short searchable English topic tags.",
  },
  metaDescription: {
    type: "string",
    minLength: 40,
    maxLength: 220,
    description: "A meta description in the same language as the draft, ideally 120-160 characters.",
  },
  metaDescriptionEn: {
    type: "string",
    minLength: 40,
    maxLength: 220,
    description: "An English meta description for the draft, ideally 120-160 characters.",
  },
};

export function normalizeMetadataFields(fields: string[]): MetadataField[] {
  const normalized: MetadataField[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    if (!isMetadataField(field) || seen.has(field)) continue;
    normalized.push(field);
    seen.add(field);
  }

  return normalized;
}

export function buildMetadataSchema(fields: MetadataField[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    properties[field] = FIELD_SCHEMAS[field];
  }

  return {
    type: "object",
    properties,
    required: fields,
    additionalProperties: false,
  };
}

export function buildMetadataGenerationRequest({
  fields,
  content,
  frontMatter,
  customPrompts,
}: {
  fields: MetadataField[];
  content: string;
  frontMatter: PostFrontMatter;
  customPrompts: Record<string, string>;
}): {
  systemPrompt: string;
  userContent: string;
  schema: Record<string, unknown>;
} {
  const fieldGuidance = fields
    .map((field) => {
      const prompt = systemPromptForField(field, customPrompts) ?? DEFAULT_GENERATION_PROMPTS[field];
      const guidance = cleanFieldGuidance(prompt);
      return `## ${FIELD_LABELS[field]} (${field})\n${guidance}`;
    })
    .join("\n\n");

  const systemPrompt = [
    "Generate publication metadata for one Markdown draft.",
    "",
    "Use the provided JSON schema as the output contract.",
    "Include exactly the requested fields. Do not include unrequested fields.",
    "",
    // The output-language rule leads, because it is the one the rest of the
    // request argues against: a Japanese draft, Japanese existing metadata and a
    // "be consistent" instruction all pull an English field into Japanese, and
    // guidance buried under a per-field heading did not hold against them.
    "Output language:",
    `- ${englishFieldList()} are always written in English, whatever language the draft is written in.`,
    `- ${draftLanguageFieldList()} are always written in the draft's own language.`,
    "- draftLanguage names the language the draft is written in. It is context, and never selects the output language of a field — the two rules above decide that alone.",
    "- Each existing metadata value is in whichever language its own field uses. Never carry the language of one into a field the rules above put in English.",
    "",
    "Existing metadata is context for consistency, not an instruction to rewrite every field.",
    "When one field is requested, keep it consistent in meaning and angle with the existing metadata unless the draft clearly contradicts it.",
    "When multiple fields are requested, keep the returned fields consistent in meaning and angle with each other.",
    "Consistency is about meaning and angle only. It never means matching another field's language.",
    "Stay close to what the draft actually says. Do not invent claims, topics, or stronger emotion.",
    "Prefer the draft content over existing metadata if they conflict.",
    "",
    "Field-specific guidance:",
    fieldGuidance,
  ].join("\n");

  const requestPayload = {
    fieldsToGenerate: fields,
    // Named `draftLanguage`, not `language`: a bare `language: "ja"` sitting
    // beside `fieldsToGenerate: ["titleEn"]` reads as the language to answer in,
    // and was doing exactly that. The key now says what it describes, and the
    // system prompt says what it does not govern.
    draftLanguage: frontMatter.language,
    target: frontMatter.target,
    existingMetadata: compactExistingMetadata(frontMatter, fields),
  };

  const userContent = [
    "<metadata_request>",
    JSON.stringify(requestPayload, null, 2),
    "</metadata_request>",
    "",
    "<draft>",
    content,
    "</draft>",
  ].join("\n");

  return {
    systemPrompt,
    userContent,
    schema: buildMetadataSchema(fields),
  };
}

export function normalizeGeneratedMetadata(
  raw: unknown,
  fields: MetadataField[]
): GeneratedMetadata {
  if (!isRecord(raw)) {
    throw new Error("Structured metadata response was not an object");
  }

  const requested = new Set<string>(fields);
  const unexpected = Object.keys(raw).filter((key) => !requested.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Structured metadata response included unexpected fields: ${unexpected.join(", ")}`);
  }

  const normalized: GeneratedMetadata = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) {
      throw new Error(`Structured metadata response omitted ${field}`);
    }
    normalized[field] = normalizeGeneratedField(field, raw[field]);
  }

  return normalized;
}

export function metadataValueToClientString(value: GeneratedMetadataValue): string {
  return Array.isArray(value) ? value.join(", ") : value;
}

function cleanFieldGuidance(prompt: string): string {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.join("\n");
}

/** "titleEn, slug, tagsEn and metaDescriptionEn", in the fields' declared order. */
function englishFieldList(): string {
  return joinFieldNames(GENERATION_PROMPT_KEYS.filter((field) => ENGLISH_METADATA_FIELDS.has(field)));
}

/** The complement of {@link englishFieldList}, so neither list can omit a field. */
function draftLanguageFieldList(): string {
  return joinFieldNames(GENERATION_PROMPT_KEYS.filter((field) => !ENGLISH_METADATA_FIELDS.has(field)));
}

function joinFieldNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The already-saved metadata, minus the fields this request is regenerating.
 *
 * A field used to be shown its own previous answer: every key went in, including
 * the ones being asked for. Paired with "keep it consistent with the existing
 * metadata", that made a wrong value self-sustaining — regenerating a titleEn
 * that had come back in Japanese handed the model that Japanese string as the
 * thing to stay consistent with, so pressing the button again reproduced it.
 * What a field is being replaced by cannot also be context for replacing it.
 */
function compactExistingMetadata(
  frontMatter: PostFrontMatter,
  requested: readonly MetadataField[],
): Partial<Record<MetadataField, unknown>> {
  const regenerating = new Set(requested);
  const existing: Partial<Record<MetadataField, unknown>> = {};
  for (const field of GENERATION_PROMPT_KEYS) {
    if (regenerating.has(field)) continue;
    const value = frontMatter[field];
    if (Array.isArray(value)) {
      const tags = value.map((tag) => tag.trim()).filter(Boolean);
      if (tags.length > 0) existing[field] = tags;
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      existing[field] = value.trim();
    }
  }
  return existing;
}

/**
 * Holds an English-only field to English. Tags are judged as one joined string
 * rather than one by one, so a single Japanese proper noun among seven English
 * tags is not read as the whole set having come back in the wrong language.
 */
function assertEnglishScript(field: MetadataField, value: string): void {
  if (isEnglishScript(value)) return;
  throw new Error(
    `Structured metadata field ${field} came back in the draft's language instead of English`
  );
}

function normalizeGeneratedField(field: MetadataField, value: unknown): GeneratedMetadataValue {
  if (field === "tags" || field === "tagsEn") {
    const tags = normalizeTags(field, value);
    if (ENGLISH_METADATA_FIELDS.has(field)) assertEnglishScript(field, tags.join(" "));
    return tags;
  }

  if (typeof value !== "string") {
    throw new Error(`Structured metadata field ${field} was not a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Structured metadata field ${field} was empty`);
  }

  if (field === "slug" && !GENERATED_SLUG.test(normalized)) {
    throw new Error("Generated slug was not URL-safe");
  }
  if (field === "slug" && normalized.length > GENERATED_SLUG_MAX_LENGTH) {
    throw new Error(`Generated slug was longer than ${GENERATED_SLUG_MAX_LENGTH} characters`);
  }

  // After the slug's own checks: its pattern is the stricter rule and gives the
  // better message, so a bad slug never reaches this one.
  if (ENGLISH_METADATA_FIELDS.has(field)) assertEnglishScript(field, normalized);

  return normalized;
}

function normalizeTags(field: MetadataField, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Structured metadata field ${field} was not an array`);
  }

  const tags = [...new Set(
    value
      .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
      .filter(Boolean)
  )];

  if (tags.length < 5 || tags.length > 8) {
    throw new Error(`Structured metadata field ${field} did not contain 5 to 8 tags`);
  }

  return tags;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
