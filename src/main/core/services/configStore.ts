/**
 * JSON config file I/O for settings, targets, and prompts.
 *
 * All public functions take a dataDir parameter (the workspace data directory).
 */

import fs from "node:fs";
import path from "node:path";
import type {
  Settings,
  Target,
  AnalysisPrompt,
  AiConfig,
  AiConfigsData,
  AiProvider,
  GenerationPromptsData,
} from "../shared/types.js";
import { obfuscate, deobfuscate } from "../shared/obfuscation.js";
import { writeFileAtomic } from "../shared/atomicWrite.js";
import { GENERATION_PROMPT_KEYS } from "../ai/generationPrompts.js";

// Per the storage-path-conventions' secrets rule, resolution prefers the
// environment: a value present in the provider's designated environment
// variable wins over the stored (obfuscated) key, so a user can supply a key
// without persisting it. The env value is main-process-internal only and is never
// written back to ai-configs.json or sent to the renderer.
const API_KEY_ENV_VAR: Record<AiProvider, string> = {
  claude: "ANTHROPIC_API_KEY",
};

function envApiKey(provider: AiProvider): string | null {
  const value = process.env[API_KEY_ENV_VAR[provider]];
  return value && value.trim() !== "" ? value.trim() : null;
}

/**
 * Reads and parses a workspace JSON config file. A corrupt file (truncated, or
 * edited by hand into invalid JSON) surfaces as a clear error naming the file,
 * rather than a bare `SyntaxError: Unexpected token` from the parser.
 */
function readJsonFile<T>(dataDir: string, fileName: string): T {
  const raw = fs.readFileSync(path.join(dataDir, fileName), "utf-8");
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new Error(`${fileName} is not valid JSON.`, { cause });
  }
}

// --- Settings ---

export function getSettings(dataDir: string): Settings {
  return readJsonFile<Settings>(dataDir, "settings.json");
}

export function saveSettings(dataDir: string, settings: Settings): Settings {
  const normalizedLanguages = [...new Set(settings.supportedLanguages)]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const normalized: Settings = {
    timezone: settings.timezone,
    supportedLanguages: normalizedLanguages,
    publishedPostsPerLoad: settings.publishedPostsPerLoad,
    maxUploadMb: settings.maxUploadMb,
    editorWatermark: settings.editorWatermark,
    extraFieldWatermark: settings.extraFieldWatermark,
  };
  writeFileAtomic(path.join(dataDir, "settings.json"), JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

// --- AI Configs ---

function readAiConfigsRaw(dataDir: string): AiConfigsData {
  return readJsonFile<AiConfigsData>(dataDir, "ai-configs.json");
}

/**
 * Returns the active AI config with its API key deobfuscated, freshly
 * constructed — never a mutated re-export of the parsed file. For
 * main-process-internal use only (analysis, generation, imaging). NEVER send the
 * result of this function to the renderer.
 *
 * Narrowing the return value to a single config means plaintext keys never
 * exist as a collection: misuse can only ever leak the one config a route
 * was already going to use.
 */
export function getActiveAiConfig(dataDir: string): AiConfig | null {
  const data = readAiConfigsRaw(dataDir);
  const stored = (data.configs ?? []).find((c) => c.id === data.activeId);
  if (!stored) return null;
  // Environment-first: an env key for this provider wins over the stored one.
  const fromEnv = envApiKey(stored.provider);
  return {
    id: stored.id,
    name: stored.name,
    provider: stored.provider,
    model: stored.model,
    apiKey: fromEnv ?? (stored.apiKey ? deobfuscate(stored.apiKey) : ""),
  };
}

/**
 * Returns AI configs with empty API key fields plus a boolean indicating
 * whether a key is already stored on disk. The plaintext key never crosses the
 * IPC bridge.
 */
export function getAiConfigsForClient(dataDir: string): AiConfigsData {
  const data = readAiConfigsRaw(dataDir);
  return {
    activeId: data.activeId,
    configs: (data.configs ?? []).map((config) => ({
      id: config.id,
      name: config.name,
      provider: config.provider,
      apiKey: "",
      hasApiKey: Boolean(config.apiKey),
      model: config.model,
    })),
  };
}

function writeAiConfigsRaw(dataDir: string, data: AiConfigsData): void {
  writeFileAtomic(
    path.join(dataDir, "ai-configs.json"),
    JSON.stringify(data, null, 2) + "\n"
  );
}

export type CreateAiConfigInput = {
  id: string;
  name: string;
  provider: AiProvider;
  model: string;
  apiKey?: string;
};

/**
 * Creates a new AI config with a caller-supplied id. Throws if the id is
 * already in use. Returns the renderer-facing config view.
 */
export function createAiConfig(dataDir: string, input: CreateAiConfigInput): AiConfigsData {
  const data = readAiConfigsRaw(dataDir);
  if ((data.configs ?? []).some((c) => c.id === input.id)) {
    throw new Error(`AI config with id "${input.id}" already exists`);
  }
  const stored: AiConfig = {
    id: input.id,
    name: input.name,
    provider: input.provider,
    model: input.model,
    apiKey: input.apiKey && input.apiKey.length > 0 ? obfuscate(input.apiKey) : "",
  };
  data.configs = [...(data.configs ?? []), stored];
  writeAiConfigsRaw(dataDir, data);
  return getAiConfigsForClient(dataDir);
}

export type UpdateAiConfigPatch = {
  name?: string;
  provider?: AiProvider;
  model?: string;
  /**
   * Key handling:
   *   - field omitted from patch → existing key is preserved
   *   - empty string ("")        → existing key is cleared
   *   - non-empty string         → existing key is replaced (and obfuscated)
   */
  apiKey?: string;
};

/**
 * Applies a partial update to a single AI config. Throws if the id does not
 * exist. Returns the renderer-facing config view.
 */
export function updateAiConfig(
  dataDir: string,
  id: string,
  patch: UpdateAiConfigPatch
): AiConfigsData {
  const data = readAiConfigsRaw(dataDir);
  const config = (data.configs ?? []).find((c) => c.id === id);
  if (!config) {
    throw new Error(`AI config with id "${id}" not found`);
  }
  if (patch.name !== undefined) config.name = patch.name;
  if (patch.provider !== undefined) config.provider = patch.provider;
  if (patch.model !== undefined) config.model = patch.model;
  if (patch.apiKey !== undefined) {
    config.apiKey = patch.apiKey.length > 0 ? obfuscate(patch.apiKey) : "";
  }
  writeAiConfigsRaw(dataDir, data);
  return getAiConfigsForClient(dataDir);
}

/**
 * Removes a single AI config. Refuses to delete the currently active config —
 * the caller must reassign `activeId` to a different config (or to "") first.
 */
export function deleteAiConfig(dataDir: string, id: string): AiConfigsData {
  const data = readAiConfigsRaw(dataDir);
  if (!(data.configs ?? []).some((c) => c.id === id)) {
    throw new Error(`AI config with id "${id}" not found`);
  }
  if (data.activeId === id) {
    throw new Error("Cannot delete the active AI config; set another active first");
  }
  data.configs = (data.configs ?? []).filter((c) => c.id !== id);
  writeAiConfigsRaw(dataDir, data);
  return getAiConfigsForClient(dataDir);
}

/**
 * Sets the active AI config. Accepts an empty string to mean "no active config".
 * Throws if a non-empty id does not refer to an existing config.
 */
export function setActiveAiConfig(dataDir: string, id: string): AiConfigsData {
  const data = readAiConfigsRaw(dataDir);
  if (id !== "" && !(data.configs ?? []).some((c) => c.id === id)) {
    throw new Error(`AI config with id "${id}" not found`);
  }
  data.activeId = id;
  writeAiConfigsRaw(dataDir, data);
  return getAiConfigsForClient(dataDir);
}

// --- Targets ---

export function getTargets(dataDir: string): Target[] {
  return readJsonFile<Target[]>(dataDir, "targets.json");
}

export function saveTargets(dataDir: string, targets: Target[]): Target[] {
  const normalized = targets.map((target) => ({
    name: target.name,
    defaultLanguage: target.defaultLanguage,
    requiresMetadata: target.requiresMetadata,
  }));
  writeFileAtomic(path.join(dataDir, "targets.json"), JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

// --- Analysis Prompts ---

export function getAnalysisPrompts(dataDir: string): AnalysisPrompt[] {
  return readJsonFile<AnalysisPrompt[]>(dataDir, "analysis-prompts.json");
}

export function saveAnalysisPrompts(dataDir: string, prompts: AnalysisPrompt[]): AnalysisPrompt[] {
  const normalized = prompts.map((prompt) => ({
    name: prompt.name,
    text: prompt.text,
  }));
  writeFileAtomic(path.join(dataDir, "analysis-prompts.json"), JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

// --- Generation Prompts ---

export function getGenerationPrompts(dataDir: string): GenerationPromptsData {
  return readJsonFile<GenerationPromptsData>(dataDir, "generation-prompts.json");
}

export function saveGenerationPrompts(
  dataDir: string,
  data: GenerationPromptsData
): GenerationPromptsData {
  const prompts: Record<string, string> = {};
  for (const key of GENERATION_PROMPT_KEYS) {
    if (typeof data.prompts[key] === "string") {
      prompts[key] = data.prompts[key];
    }
  }
  const normalized: GenerationPromptsData = { prompts };
  writeFileAtomic(
    path.join(dataDir, "generation-prompts.json"),
    JSON.stringify(normalized, null, 2) + "\n"
  );
  return normalized;
}
