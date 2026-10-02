import type { Settings } from "./types.js";
import { AI_PROVIDERS, isAiConfigId, validateMaxTokens } from "./types.js";
import { settingsSetErrors } from "./settingsValidation.js";
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

export type WorkspaceSetKey = (typeof WORKSPACE_SET_KEYS)[number];

function isSettingsKey(key: WorkspaceSetKey): key is keyof Settings {
  return (SETTINGS_SET_KEYS as readonly string[]).includes(key);
}

function shapeIssue(key: WorkspaceSetKey, value: unknown): string | null {
  switch (key) {
    case "supportedLanguages":
      return strings(value) ? null : "supportedLanguages must be an array of strings";
    case "publishedPostsPerLoad":
    case "maxUploadMb":
      return typeof value === "number" ? null : `${key} must be a number`;
    case "contentFont":
      if (!object(value)) return "contentFont must be an object";
      if (typeof value.family !== "string") return "contentFont.family must be a string";
      if (![value.size, value.lineHeight, value.padding].every((v) => typeof v === "number")) {
        return "contentFont.size, .lineHeight, and .padding must be numbers";
      }
      if (![value.bold, value.italic, value.underline].every((v) => typeof v === "boolean")) {
        return "contentFont.bold, .italic, and .underline must be booleans";
      }
      return null;
    case "targets":
      if (!Array.isArray(value)) return "targets must be an array";
      for (const target of value) {
        if (!object(target)) return "each target must be an object";
        if (typeof target.name !== "string" || !target.name.trim()) return "each target needs a non-empty name";
        if (typeof target.defaultLanguage !== "string") return "each target needs a defaultLanguage string";
        if (typeof target.requiresMetadata !== "boolean") return "each target needs a boolean requiresMetadata";
      }
      return null;
    case "analysisPrompts":
      if (!Array.isArray(value)) return "analysis prompts must be an array";
      for (const prompt of value) {
        if (!object(prompt)) return "each prompt must be an object";
        if (typeof prompt.name !== "string" || !prompt.name.trim()) return "each prompt needs a non-empty name";
        if (typeof prompt.text !== "string") return "each prompt needs a text string";
      }
      return null;
    case "generationPrompts": {
      const prompts = object(value) && object(value.prompts) ? value.prompts : null;
      const valid = prompts !== null &&
        Object.keys(prompts).length === GENERATION_PROMPT_KEYS.length &&
        GENERATION_PROMPT_KEYS.every((k) => typeof prompts[k] === "string");
      return valid ? null : "prompts must map every generation prompt key, and no other, to a string";
    }
    case "aiConfigs": {
      const valid = Array.isArray(value) && value.every((v) => object(v) &&
        isAiConfigId(v.id) && typeof v.name === "string" &&
        AI_PROVIDERS.includes(v.provider as typeof AI_PROVIDERS[number]) &&
        typeof v.model === "string" && typeof v.thinking === "boolean" &&
        typeof v.maxTokens === "number" && validateMaxTokens(v.maxTokens) === null) &&
        new Set(value.map((v) => v.id)).size === value.length;
      return valid ? null : "aiConfigs must be a list of valid AI configs with unique ids";
    }
    default:
      return typeof value === "string" ? null : `${key} must be a string`;
  }
}

/** The one check per set, applied where Save accepts it and where it is read (config-sets-conventions). */
export function workspaceSetIssue(key: WorkspaceSetKey, value: unknown): string | null {
  const issue = shapeIssue(key, value);
  if (issue !== null || !isSettingsKey(key)) return issue;
  const [field, error] = Object.entries(settingsSetErrors(key, value as Settings[typeof key]))[0] ?? [];
  return field && error ? `${field}: ${error.key}` : null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** The file content per config-sets-conventions: each set that differs from its built-in, whole. */
export function setsDifferingFromBuiltIn<T extends object>(
  values: T,
  builtIn: T,
  keys: readonly (keyof T & string)[],
): Record<string, unknown> {
  const sets: Record<string, unknown> = {};
  for (const key of keys) {
    if (JSON.stringify(canonical(values[key])) !== JSON.stringify(canonical(builtIn[key]))) sets[key] = values[key];
  }
  return sets;
}
