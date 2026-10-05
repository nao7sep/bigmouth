import type { Settings } from "./types.js";
import { settingsSetErrors } from "./settingsValidation.js";
import { GENERATION_PROMPT_KEYS } from "./metadataFields.js";
import { AI_ROLE_IDS, rowFor, thinkingFor, type AiRole } from "./aiModels.js";

export const SETTINGS_SET_KEYS = [
  "timezone", "supportedLanguages", "publishedPostsPerLoad", "maxUploadMb",
  "editorWatermark", "extraFieldWatermark", "uiFontFamily", "contentFont",
] as const satisfies readonly (keyof Settings)[];
// The Anthropic section (ai-model-routing-conventions): its endpoint, one model
// per role and one thinking value per role, each its own set.
export const ANTHROPIC_SET_KEYS = [
  "anthropic.endpoint",
  "anthropic.analysis", "anthropic.metadata", "anthropic.imagingPrompts",
  "anthropic.thinking.analysis", "anthropic.thinking.metadata", "anthropic.thinking.imagingPrompts",
] as const satisfies readonly (`anthropic.${"endpoint" | AiRole}` | `anthropic.thinking.${AiRole}`)[];
export type AnthropicSetKey = (typeof ANTHROPIC_SET_KEYS)[number];

export const modelSetKey = (role: AiRole) => `anthropic.${role}` as const;
export const thinkingSetKey = (role: AiRole) => `anthropic.thinking.${role}` as const;

export const WORKSPACE_SET_KEYS = [
  ...SETTINGS_SET_KEYS, "targets", ...ANTHROPIC_SET_KEYS, "analysisPrompts", "generationPrompts",
] as const;

const MODEL_SET_ROLES: ReadonlyMap<string, AiRole> = new Map(AI_ROLE_IDS.map((role) => [modelSetKey(role), role]));
const THINKING_SET_ROLES: ReadonlyMap<string, AiRole> = new Map(AI_ROLE_IDS.map((role) => [thinkingSetKey(role), role]));

/** An endpoint is an absolute http(s) URL; anything else could never be called. */
export function isEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

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
    case "anthropic.endpoint":
      return isEndpoint(value) ? null : "anthropic.endpoint must be an http or https URL";
    default:
      if (typeof value !== "string") return `${key} must be a string`;
      // A model id is free text the store never judges, but a role needs one.
      if (MODEL_SET_ROLES.has(key) && !value.trim()) return `${key} must name a model`;
      return null;
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

// A model id is its own key, compared trimmed and case-insensitively. A role's
// thinking equals its built-in while the value it sends is the default for the
// model the role selects, and always for a model with no row.
function equalsBuiltIn(key: string, values: Record<string, unknown>, builtIn: Record<string, unknown>): boolean {
  const value = values[key];
  const thinkingRole = THINKING_SET_ROLES.get(key);
  if (thinkingRole) {
    const row = rowFor(String(values[modelSetKey(thinkingRole)] ?? ""));
    return !row || thinkingFor(row.id, String(value)) === row.defaultThinking;
  }
  if (MODEL_SET_ROLES.has(key)) {
    return typeof value === "string" && value.trim().toLowerCase() === String(builtIn[key]).toLowerCase();
  }
  return JSON.stringify(canonical(value)) === JSON.stringify(canonical(builtIn[key]));
}

/** The file content per config-sets-conventions: each set that differs from its built-in, whole. */
export function setsDifferingFromBuiltIn<T extends object>(
  values: T,
  builtIn: T,
  keys: readonly (keyof T & string)[],
): Record<string, unknown> {
  const sets: Record<string, unknown> = {};
  for (const key of keys) {
    if (!equalsBuiltIn(key, values as Record<string, unknown>, builtIn as Record<string, unknown>)) sets[key] = values[key];
  }
  return sets;
}
