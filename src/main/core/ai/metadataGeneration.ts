import type { PostFrontMatter } from "../shared/types.js";
import {
  DEFAULT_GENERATION_PROMPTS,
  GENERATION_PROMPT_KEYS,
  systemPromptForField,
} from "./generationPrompts.js";

export type MetadataField = (typeof GENERATION_PROMPT_KEYS)[number];
export type GeneratedMetadataValue = string | string[];
export type GeneratedMetadata = Partial<Record<MetadataField, GeneratedMetadataValue>>;

const METADATA_FIELD_SET = new Set<string>(GENERATION_PROMPT_KEYS);

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
    maxLength: 60,
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
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

export function isMetadataField(value: string): value is MetadataField {
  return METADATA_FIELD_SET.has(value);
}

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
    "Existing metadata is context for consistency, not an instruction to rewrite every field.",
    "When one field is requested, make it fit the existing metadata unless the draft clearly contradicts it.",
    "When multiple fields are requested, make the returned fields mutually consistent.",
    "Stay close to what the draft actually says. Do not invent claims, topics, or stronger emotion.",
    "Prefer the draft content over existing metadata if they conflict.",
    "",
    "Field-specific guidance:",
    fieldGuidance,
  ].join("\n");

  const requestPayload = {
    fieldsToGenerate: fields,
    language: frontMatter.language,
    target: frontMatter.target,
    existingMetadata: compactExistingMetadata(frontMatter),
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

function compactExistingMetadata(frontMatter: PostFrontMatter): Partial<Record<MetadataField, unknown>> {
  const existing: Partial<Record<MetadataField, unknown>> = {};
  for (const field of GENERATION_PROMPT_KEYS) {
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

function normalizeGeneratedField(field: MetadataField, value: unknown): GeneratedMetadataValue {
  if (field === "tags" || field === "tagsEn") {
    return normalizeTags(field, value);
  }

  if (typeof value !== "string") {
    throw new Error(`Structured metadata field ${field} was not a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Structured metadata field ${field} was empty`);
  }

  if (field === "slug" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error("Generated slug was not URL-safe");
  }
  if (field === "slug" && normalized.length > 60) {
    throw new Error("Generated slug was longer than 60 characters");
  }

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
