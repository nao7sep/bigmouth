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
  StoredAiConfig,
  StoredAiConfigsData,
  GenerationPromptsData,
  Workspace,
} from "../shared/types.js";
import { writeFileAtomic } from "../shared/atomicWrite.js";
import { DEFAULT_SETTINGS } from "../shared/defaults.js";
import { GENERATION_PROMPT_KEYS } from "../ai/generationPrompts.js";
import * as apiKeys from "./apiKeys.js";
import { getApiKeysPath } from "./workspaceStore.js";

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
  // Fill any field absent from the on-disk file with its default, so a settings
  // file written before a field existed loads cleanly instead of yielding an
  // `undefined` the renderer/validator then trips over. This is a defaults
  // backfill, not schema-migration scaffolding — the app is pre-release, so new
  // fields simply default in place (PLAYBOOK).
  return { ...DEFAULT_SETTINGS, ...readJsonFile<Settings>(dataDir, "settings.json") };
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
    uiFontFamily: settings.uiFontFamily,
    // Rebuilt field-by-field (like the rest of normalized) so no stray key from a
    // hand-edited file is written back.
    contentFont: {
      family: settings.contentFont.family,
      size: settings.contentFont.size,
      lineHeight: settings.contentFont.lineHeight,
      padding: settings.contentFont.padding,
      bold: settings.contentFont.bold,
      italic: settings.contentFont.italic,
      underline: settings.contentFont.underline,
    },
  };
  writeFileAtomic(path.join(dataDir, "settings.json"), JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

// --- AI Configs ---

function readAiConfigsRaw(dataDir: string): StoredAiConfigsData {
  return readJsonFile<StoredAiConfigsData>(dataDir, "ai-configs.json");
}

// Persist only the non-secret config shape. Rebuilding each entry from its known
// fields guarantees no `apiKey` (or any other stray field from a legacy file)
// is ever written back into the git-versionable workspace.
function writeAiConfigsRaw(dataDir: string, data: StoredAiConfigsData): void {
  const persisted: StoredAiConfigsData = {
    activeId: data.activeId,
    configs: (data.configs ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      model: c.model,
    })),
  };
  writeFileAtomic(path.join(dataDir, "ai-configs.json"), JSON.stringify(persisted, null, 2) + "\n");
}

/**
 * Returns the active AI config with its API key resolved (environment-first, then
 * the storage-root secrets file — never the workspace), freshly constructed. For
 * main-process-internal use only (analysis, generation, imaging). NEVER send the
 * result of this function to the renderer.
 *
 * Narrowing the return value to a single config means plaintext keys never
 * exist as a collection: misuse can only ever leak the one config a route
 * was already going to use.
 */
export function getActiveAiConfig(workspace: Workspace): AiConfig | null {
  const data = readAiConfigsRaw(workspace.dataDirectory);
  const stored = (data.configs ?? []).find((c) => c.id === data.activeId);
  if (!stored) return null;
  return {
    id: stored.id,
    name: stored.name,
    provider: stored.provider,
    model: stored.model,
    apiKey: apiKeys.resolveApiKey(getApiKeysPath(), workspace.id, stored.id, stored.provider) ?? "",
  };
}

/**
 * Returns AI configs for the renderer: empty key fields, a per-config `hasApiKey`
 * (a key is stored for THIS config) and `usingEnvKey` (the provider's env var is
 * set and overrides any stored key). The secrets file is read once. The key value
 * never crosses the IPC bridge.
 */
export function getAiConfigsForClient(workspace: Workspace): AiConfigsData {
  const data = readAiConfigsRaw(workspace.dataDirectory);
  const storedIds = apiKeys.readStoredConfigIds(getApiKeysPath(), workspace.id);
  return {
    activeId: data.activeId,
    configs: (data.configs ?? []).map((config) => ({
      id: config.id,
      name: config.name,
      provider: config.provider,
      apiKey: "",
      hasApiKey: storedIds.has(config.id),
      usingEnvKey: apiKeys.hasEnvApiKey(config.provider),
      model: config.model,
    })),
  };
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
 * already in use. Any supplied key goes to the secrets file, not the workspace.
 * Returns the renderer-facing config view.
 */
export function createAiConfig(workspace: Workspace, input: CreateAiConfigInput): AiConfigsData {
  const data = readAiConfigsRaw(workspace.dataDirectory);
  if ((data.configs ?? []).some((c) => c.id === input.id)) {
    throw new Error(`AI config with id "${input.id}" already exists`);
  }
  const stored: StoredAiConfig = {
    id: input.id,
    name: input.name,
    provider: input.provider,
    model: input.model,
  };
  data.configs = [...(data.configs ?? []), stored];
  // Config first, then key: the key is only meaningful once its config exists, so
  // a failed key write at worst leaves a keyless config the user can re-key. (The
  // workspace file and the secrets file are separate; they cannot be made atomic
  // without machinery, so ordering bounds the blast radius instead.)
  writeAiConfigsRaw(workspace.dataDirectory, data);
  if (input.apiKey !== undefined) {
    apiKeys.writeApiKey(getApiKeysPath(), workspace.id, input.id, input.apiKey);
  }
  return getAiConfigsForClient(workspace);
}

export type UpdateAiConfigPatch = {
  name?: string;
  provider?: AiProvider;
  model?: string;
  /**
   * Key handling (the key lives in the secrets file, not the workspace):
   *   - field omitted from patch → existing key is preserved
   *   - blank string             → existing key is cleared
   *   - non-blank string         → existing key is replaced
   */
  apiKey?: string;
};

/**
 * Applies a partial update to a single AI config. Throws if the id does not
 * exist. Returns the renderer-facing config view.
 */
export function updateAiConfig(
  workspace: Workspace,
  id: string,
  patch: UpdateAiConfigPatch
): AiConfigsData {
  const data = readAiConfigsRaw(workspace.dataDirectory);
  const config = (data.configs ?? []).find((c) => c.id === id);
  if (!config) {
    throw new Error(`AI config with id "${id}" not found`);
  }
  const metadataChanged =
    patch.name !== undefined || patch.provider !== undefined || patch.model !== undefined;
  if (patch.name !== undefined) config.name = patch.name;
  if (patch.provider !== undefined) config.provider = patch.provider;
  if (patch.model !== undefined) config.model = patch.model;
  // Key to the secrets file first, so a failure there leaves the workspace file
  // untouched. Rewrite the workspace file only when a non-secret field changed —
  // a key-only edit must not dirty the git-versioned ai-configs.json.
  if (patch.apiKey !== undefined) {
    apiKeys.writeApiKey(getApiKeysPath(), workspace.id, id, patch.apiKey);
  }
  if (metadataChanged) {
    writeAiConfigsRaw(workspace.dataDirectory, data);
  }
  return getAiConfigsForClient(workspace);
}

/**
 * Removes a single AI config and its stored key. Refuses to delete the currently
 * active config — the caller must reassign `activeId` (or set it to "") first.
 */
export function deleteAiConfig(workspace: Workspace, id: string): AiConfigsData {
  const data = readAiConfigsRaw(workspace.dataDirectory);
  if (!(data.configs ?? []).some((c) => c.id === id)) {
    throw new Error(`AI config with id "${id}" not found`);
  }
  if (data.activeId === id) {
    throw new Error("Cannot delete the active AI config; set another active first");
  }
  data.configs = (data.configs ?? []).filter((c) => c.id !== id);
  writeAiConfigsRaw(workspace.dataDirectory, data);
  apiKeys.clearApiKey(getApiKeysPath(), workspace.id, id);
  return getAiConfigsForClient(workspace);
}

/**
 * Sets the active AI config. Accepts an empty string to mean "no active config".
 * Throws if a non-empty id does not refer to an existing config.
 */
export function setActiveAiConfig(workspace: Workspace, id: string): AiConfigsData {
  const data = readAiConfigsRaw(workspace.dataDirectory);
  if (id !== "" && !(data.configs ?? []).some((c) => c.id === id)) {
    throw new Error(`AI config with id "${id}" not found`);
  }
  data.activeId = id;
  writeAiConfigsRaw(workspace.dataDirectory, data);
  return getAiConfigsForClient(workspace);
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
