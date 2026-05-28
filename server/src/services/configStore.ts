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
import { GENERATION_PROMPT_KEYS } from "../ai/generationPrompts.js";

// --- Settings ---

export function getSettings(dataDir: string): Settings {
  const raw = fs.readFileSync(path.join(dataDir, "settings.json"), "utf-8");
  return JSON.parse(raw) as Settings;
}

export function saveSettings(dataDir: string, settings: Settings): void {
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
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify(normalized, null, 2) + "\n");
}

// --- AI Configs ---

function readAiConfigsRaw(dataDir: string): AiConfigsData {
  const raw = fs.readFileSync(path.join(dataDir, "ai-configs.json"), "utf-8");
  return JSON.parse(raw) as AiConfigsData;
}

/**
 * Returns the active AI config with its API key deobfuscated, freshly
 * constructed — never a mutated re-export of the parsed file. For
 * server-internal use only (analysis, generation, imaging). NEVER send the
 * result of this function to the client.
 *
 * Narrowing the return value to a single config means plaintext keys never
 * exist as a collection: misuse can only ever leak the one config a route
 * was already going to use.
 */
export function getActiveAiConfig(dataDir: string): AiConfig | null {
  const data = readAiConfigsRaw(dataDir);
  const stored = (data.configs ?? []).find((c) => c.id === data.activeId);
  if (!stored) return null;
  return {
    id: stored.id,
    name: stored.name,
    provider: stored.provider,
    model: stored.model,
    apiKey: stored.apiKey ? deobfuscate(stored.apiKey) : "",
  };
}

/**
 * Returns AI configs with empty API key fields plus a boolean indicating
 * whether a key is already stored server-side. The plaintext key is never sent
 * over HTTP.
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
  fs.writeFileSync(
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
 * already in use. Returns the updated client view.
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
 * exist. Returns the updated client view.
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
  const raw = fs.readFileSync(path.join(dataDir, "targets.json"), "utf-8");
  return JSON.parse(raw) as Target[];
}

export function saveTargets(dataDir: string, targets: Target[]): void {
  const normalized = targets.map((target) => ({
    name: target.name,
    defaultLanguage: target.defaultLanguage,
    requiresMetadata: target.requiresMetadata,
  }));
  fs.writeFileSync(path.join(dataDir, "targets.json"), JSON.stringify(normalized, null, 2) + "\n");
}

// --- Analysis Prompts ---

export function getAnalysisPrompts(dataDir: string): AnalysisPrompt[] {
  const raw = fs.readFileSync(path.join(dataDir, "analysis-prompts.json"), "utf-8");
  return JSON.parse(raw) as AnalysisPrompt[];
}

export function saveAnalysisPrompts(dataDir: string, prompts: AnalysisPrompt[]): void {
  const normalized = prompts.map((prompt) => ({
    name: prompt.name,
    text: prompt.text,
  }));
  fs.writeFileSync(path.join(dataDir, "analysis-prompts.json"), JSON.stringify(normalized, null, 2) + "\n");
}

// --- Generation Prompts ---

export function getGenerationPrompts(dataDir: string): GenerationPromptsData {
  const raw = fs.readFileSync(path.join(dataDir, "generation-prompts.json"), "utf-8");
  return JSON.parse(raw) as GenerationPromptsData;
}

export function saveGenerationPrompts(dataDir: string, data: GenerationPromptsData): void {
  const prompts: Record<string, string> = {};
  for (const key of GENERATION_PROMPT_KEYS) {
    if (typeof data.prompts[key] === "string") {
      prompts[key] = data.prompts[key];
    }
  }
  fs.writeFileSync(
    path.join(dataDir, "generation-prompts.json"),
    JSON.stringify({ prompts }, null, 2) + "\n"
  );
}
