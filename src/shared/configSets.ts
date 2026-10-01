import type { Settings } from "./types.js";
import { AI_PROVIDERS, isAiConfigId } from "./types.js";
import { GENERATION_PROMPT_KEYS } from "./metadataFields.js";

export const SETTINGS_SET_KEYS = [
  "timezone", "supportedLanguages", "publishedPostsPerLoad", "maxUploadMb",
  "editorWatermark", "extraFieldWatermark", "uiFontFamily", "contentFont",
] as const satisfies readonly (keyof Settings)[];
export const WORKSPACE_SET_KEYS = [
  ...SETTINGS_SET_KEYS, "targets", "aiConfigs", "analysisPrompts", "generationPrompts",
] as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Shape only; feature boundaries still own value validity. */
export function workspaceSetHasShape(key: (typeof WORKSPACE_SET_KEYS)[number], value: unknown): boolean {
  switch (key) {
    case "supportedLanguages": return strings(value);
    case "publishedPostsPerLoad":
    case "maxUploadMb": return typeof value === "number";
    case "contentFont": return object(value) &&
      typeof value.family === "string" &&
      [value.size, value.lineHeight, value.padding].every((v) => typeof v === "number") &&
      [value.bold, value.italic, value.underline].every((v) => typeof v === "boolean");
    case "targets": return Array.isArray(value) && value.every((v) => object(v) &&
      typeof v.name === "string" && typeof v.defaultLanguage === "string" &&
      typeof v.requiresMetadata === "boolean");
    case "analysisPrompts": return Array.isArray(value) && value.every((v) => object(v) &&
      typeof v.name === "string" && typeof v.text === "string");
    case "generationPrompts": return object(value) && object(value.prompts) &&
      GENERATION_PROMPT_KEYS.every((key) => Object.hasOwn(value.prompts as object, key)) &&
      Object.values(value.prompts).every((v) => typeof v === "string");
    case "aiConfigs": return Array.isArray(value) && value.every((v) => object(v) &&
      isAiConfigId(v.id) && typeof v.name === "string" &&
      AI_PROVIDERS.includes(v.provider as typeof AI_PROVIDERS[number]) &&
      typeof v.model === "string" && typeof v.thinking === "boolean" &&
      typeof v.maxTokens === "number") &&
      new Set(value.map((v) => v.id)).size === value.length;
    default: return typeof value === "string";
  }
}

/** A dialog sends only the set copies whose drafts changed. */
export function changedSets<T extends object>(draft: T, initial: T): Partial<T> {
  const changes: Partial<T> = {};
  for (const key of Object.keys(draft) as (keyof T)[]) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(initial[key])) changes[key] = draft[key];
  }
  return changes;
}
