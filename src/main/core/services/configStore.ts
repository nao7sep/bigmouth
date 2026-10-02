/** Workspace settings are read and written by whole set. Secrets and selection have separate owners. */

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
  WorkspaceConfig,
  Workspace,
} from "../shared/types.js";
import { SETTINGS_SET_KEYS, WORKSPACE_SET_KEYS, setsDifferingFromBuiltIn, workspaceSetIssue } from "@shared/configSets";
import { isWorkspaceConfig } from "../shared/workspaceConfigShape.js";
import { writeSetFile } from "../shared/setFile.js";
import { makeDefaultConfig } from "../shared/defaults.js";
import { warn } from "./logger.js";
import * as apiKeys from "./apiKeys.js";
import { getApiKeysPath } from "./storagePaths.js";
import { resolveActiveConfigId, setActiveConfigId } from "./activeConfig.js";

const CONFIG_FILE = "config.json";

function readMap(dataDir: string): Record<string, unknown> {
  const filePath = path.join(dataDir, CONFIG_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${CONFIG_FILE} is not valid JSON. It was left unchanged at ${filePath}`, { cause });
  }
  if (!isWorkspaceConfig(parsed)) {
    throw new Error(`${CONFIG_FILE} is not a BigMouth workspace config. It was left unchanged at ${filePath}`);
  }
  return parsed;
}

function readConfig(dataDir: string): WorkspaceConfig {
  const map = readMap(dataDir);
  const config = structuredClone(makeDefaultConfig());
  for (const key of WORKSPACE_SET_KEYS) {
    if (!Object.hasOwn(map, key)) continue;
    const issue = workspaceSetIssue(key, map[key]);
    if (issue === null) Object.assign(config, { [key]: map[key] });
    else warn("workspace config set is invalid; using built-in", { path: path.join(dataDir, CONFIG_FILE), key, issue });
  }
  return config;
}

function writeSets(dataDir: string, changes: Partial<WorkspaceConfig>): void {
  const config = { ...readConfig(dataDir), ...changes };
  writeSetFile(path.join(dataDir, CONFIG_FILE), setsDifferingFromBuiltIn(config, makeDefaultConfig(), WORKSPACE_SET_KEYS));
}

function normalizeSettings(settings: Settings): Settings {
  const known = Object.fromEntries(SETTINGS_SET_KEYS.map((key) => [key, settings[key]])) as unknown as Settings;
  return {
    ...known,
    supportedLanguages: [...new Set(settings.supportedLanguages)].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })),
  };
}

function normalizeTargets(targets: Target[]): Target[] {
  return targets.map(({ name, defaultLanguage, requiresMetadata }) => ({ name, defaultLanguage, requiresMetadata }));
}

function normalizeAnalysisPrompts(prompts: AnalysisPrompt[]): AnalysisPrompt[] {
  return prompts.map(({ name, text }) => ({ name, text }));
}

// --- Settings -----------------------------------------------------------------

export function getSettings(dataDir: string): Settings {
  const c = readConfig(dataDir);
  return {
    timezone: c.timezone,
    supportedLanguages: c.supportedLanguages,
    publishedPostsPerLoad: c.publishedPostsPerLoad,
    maxUploadMb: c.maxUploadMb,
    editorWatermark: c.editorWatermark,
    extraFieldWatermark: c.extraFieldWatermark,
    uiFontFamily: c.uiFontFamily,
    contentFont: c.contentFont,
  };
}

export function saveSettings(dataDir: string, settings: Partial<Settings>): Settings {
  writeSets(dataDir, normalizeSettings({ ...getSettings(dataDir), ...settings }));
  return getSettings(dataDir);
}

// --- AI Configs ---------------------------------------------------------------

/**
 * Returns the active AI config with its API key resolved (environment-first, then
 * the storage-root secrets file — never the workspace), freshly constructed. For
 * main-process-internal use only (analysis, generation, imaging). NEVER send the
 * result of this function to the renderer.
 *
 * Narrowing the return value to a single config means plaintext keys never exist
 * as a collection: misuse can only ever leak the one config a route was already
 * going to use.
 */
export function getActiveAiConfig(workspace: Workspace): AiConfig | null {
  const { aiConfigs } = readConfig(workspace.dataDirectory);
  const activeId = resolveActiveConfigId(workspace.id, aiConfigs);
  const stored = aiConfigs.find((c) => c.id === activeId);
  if (!stored) return null;
  return {
    id: stored.id,
    name: stored.name,
    provider: stored.provider,
    model: stored.model,
    thinking: stored.thinking,
    maxTokens: stored.maxTokens,
    apiKey: apiKeys.resolveApiKey(getApiKeysPath(), workspace.id, stored.id, stored.provider) ?? "",
  };
}

/**
 * Returns AI configs for the renderer: empty key fields, a per-config `hasApiKey`
 * (a key is stored for THIS config) and `usingEnvKey` (the provider's env var is
 * set and overrides any stored key), plus the session-active config id. The key
 * value never crosses the IPC bridge.
 */
export function getAiConfigsForClient(workspace: Workspace): AiConfigsData {
  const { aiConfigs } = readConfig(workspace.dataDirectory);
  const storedIds = apiKeys.readStoredConfigIds(getApiKeysPath(), workspace.id);
  return {
    activeId: resolveActiveConfigId(workspace.id, aiConfigs),
    configs: aiConfigs.map((config) => ({
      id: config.id,
      name: config.name,
      provider: config.provider,
      apiKey: "",
      hasApiKey: storedIds.has(config.id),
      usingEnvKey: apiKeys.hasEnvApiKey(config.provider),
      model: config.model,
      thinking: config.thinking,
      maxTokens: config.maxTokens,
    })),
  };
}

export type CreateAiConfigInput = {
  id: string;
  name: string;
  provider: AiProvider;
  model: string;
  thinking: boolean;
  maxTokens: number;
  apiKey?: string;
};

/**
 * Creates a new AI config with a caller-supplied id. Throws if the id is already
 * in use. Any supplied key goes to the secrets file, not the workspace. Returns
 * the renderer-facing config view.
 */
export function createAiConfig(workspace: Workspace, input: CreateAiConfigInput): AiConfigsData {
  const config = readConfig(workspace.dataDirectory);
  if (config.aiConfigs.some((c) => c.id === input.id)) {
    throw new Error(`AI config with id "${input.id}" already exists`);
  }
  config.aiConfigs = [
    ...config.aiConfigs,
    {
      id: input.id,
      name: input.name,
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
      maxTokens: input.maxTokens,
    },
  ];
  // Config first, then key: the key is only meaningful once its config exists, so
  // a failed key write at worst leaves a keyless config the user can re-key. (The
  // workspace file and the secrets file are separate; they cannot be made atomic
  // without machinery, so ordering bounds the blast radius instead.)
  writeSets(workspace.dataDirectory, { aiConfigs: config.aiConfigs });
  if (input.apiKey !== undefined) {
    apiKeys.writeApiKey(getApiKeysPath(), workspace.id, input.id, input.provider, input.apiKey);
  }
  return getAiConfigsForClient(workspace);
}

export type UpdateAiConfigPatch = {
  name?: string;
  provider?: AiProvider;
  model?: string;
  thinking?: boolean;
  maxTokens?: number;
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
  const config = readConfig(workspace.dataDirectory);
  const target = config.aiConfigs.find((c) => c.id === id);
  if (!target) {
    throw new Error(`AI config with id "${id}" not found`);
  }
  // Applied by walking the editable keys rather than one `if` per field. The
  // field list was written twice — once in UpdateAiConfigPatch, once here — and
  // had fallen out of sync: `thinking` and `maxTokens` were declared, validated
  // by the IPC handler and logged as changed, then dropped on the floor. The
  // user toggled Thinking or edited Max tokens, saw the modal repaint from the
  // returned view with the old values, and every AI call kept the old budget.
  const editable = ["name", "provider", "model", "thinking", "maxTokens"] as const;
  let metadataChanged = false;
  for (const key of editable) {
    if (patch[key] === undefined) continue;
    // Each key's value type matches the field it is assigned to; the cast is
    // only because TypeScript cannot see that through a union of keys.
    Object.assign(target, { [key]: patch[key] });
    metadataChanged = true;
  }
  // Key to the secrets file first, so a failure there leaves the workspace file
  // untouched. Rewrite the workspace file only when a non-secret field changed —
  // a key-only edit must not dirty the git-versioned config.json.
  if (patch.apiKey !== undefined) {
    apiKeys.writeApiKey(getApiKeysPath(), workspace.id, id, target.provider, patch.apiKey);
  }
  if (metadataChanged) {
    writeSets(workspace.dataDirectory, { aiConfigs: config.aiConfigs });
  }
  return getAiConfigsForClient(workspace);
}

/**
 * Removes a single AI config and its stored key. Deleting the session-active
 * config is fine — the active selection simply falls back to the first remaining
 * config (or to none when the last is removed); there is no persisted id to
 * orphan.
 */
export function deleteAiConfig(workspace: Workspace, id: string): AiConfigsData {
  const config = readConfig(workspace.dataDirectory);
  if (!config.aiConfigs.some((c) => c.id === id)) {
    throw new Error(`AI config with id "${id}" not found`);
  }
  config.aiConfigs = config.aiConfigs.filter((c) => c.id !== id);
  writeSets(workspace.dataDirectory, { aiConfigs: config.aiConfigs });
  apiKeys.clearApiKey(getApiKeysPath(), workspace.id, id);
  return getAiConfigsForClient(workspace);
}

/**
 * Selects the active AI config (remembered per workspace in state.json). Accepts an empty
 * string to clear the selection (the active config falls back to the first).
 * Throws if a non-empty id does not refer to an existing config.
 */
export function setActiveAiConfig(workspace: Workspace, id: string): AiConfigsData {
  const config = readConfig(workspace.dataDirectory);
  if (id !== "" && !config.aiConfigs.some((c) => c.id === id)) {
    throw new Error(`AI config with id "${id}" not found`);
  }
  setActiveConfigId(workspace.id, id);
  return getAiConfigsForClient(workspace);
}

// --- Targets ------------------------------------------------------------------

export function getTargets(dataDir: string): Target[] {
  return readConfig(dataDir).targets;
}

export function saveTargets(dataDir: string, targets: Target[]): Target[] {
  const normalized = normalizeTargets(targets);
  writeSets(dataDir, { targets: normalized });
  return normalized;
}

// --- Analysis Prompts ---------------------------------------------------------

export function getAnalysisPrompts(dataDir: string): AnalysisPrompt[] {
  return readConfig(dataDir).analysisPrompts;
}

export function saveAnalysisPrompts(dataDir: string, prompts: AnalysisPrompt[]): AnalysisPrompt[] {
  const normalized = normalizeAnalysisPrompts(prompts);
  writeSets(dataDir, { analysisPrompts: normalized });
  return normalized;
}

// --- Generation Prompts -------------------------------------------------------

export function getGenerationPrompts(dataDir: string): GenerationPromptsData {
  return readConfig(dataDir).generationPrompts;
}

export function saveGenerationPrompts(
  dataDir: string,
  data: GenerationPromptsData
): GenerationPromptsData {
  writeSets(dataDir, { generationPrompts: data });
  return data;
}
