/**
 * Workspace configuration I/O.
 *
 * A workspace's durable settings all live in ONE file, `config.json` — flat (no
 * nested "settings" wrapper), with its top-level keys ordered to mirror the
 * Settings modal: general fields, then targets, AI configs, analysis prompts,
 * generation prompts. This module is the sole reader/writer of that file; each
 * section accessor reads a normalized config and replaces one section.
 *
 * The active AI config is NOT in the file — it is volatile session state
 * (services/activeConfig), defaulting to the first config on each launch.
 *
 * The AI config functions take a Workspace (they need its id for the secrets
 * file); the section accessors take the workspace data directory.
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
  GenerationPromptsData,
  WorkspaceConfig,
  Workspace,
} from "../shared/types.js";
import { CONFIG_SCHEMA_VERSION } from "../shared/types.js";
import { writeManagedText } from "../shared/atomicWrite.js";
import { DEFAULT_SETTINGS } from "../shared/defaults.js";
import { GENERATION_PROMPT_KEYS } from "../ai/generationPrompts.js";
import * as apiKeys from "./apiKeys.js";
import { getApiKeysPath } from "./workspaceStore.js";
import { resolveActiveConfigId, setActiveConfigId } from "./activeConfig.js";

const CONFIG_FILE = "config.json";

// --- section normalizers ------------------------------------------------------
//
// Each rebuilds its section field-by-field from defaults + the on-disk value, so
// a hand-edited file's stray keys are never carried forward and absent fields
// backfill cleanly (a defaults backfill, not migration scaffolding — the app is
// pre-release). These are reused on read (normalizeConfig) and on section saves.

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function normalizeSettings(raw: unknown): Settings {
  const s = { ...DEFAULT_SETTINGS, ...asObject(raw) } as Settings;
  const cf = { ...DEFAULT_SETTINGS.contentFont, ...asObject((raw as { contentFont?: unknown }).contentFont) };
  return {
    timezone: s.timezone,
    supportedLanguages: [...new Set(s.supportedLanguages)].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    ),
    publishedPostsPerLoad: s.publishedPostsPerLoad,
    maxUploadMb: s.maxUploadMb,
    editorWatermark: s.editorWatermark,
    extraFieldWatermark: s.extraFieldWatermark,
    uiFontFamily: s.uiFontFamily,
    contentFont: {
      family: cf.family,
      size: cf.size,
      lineHeight: cf.lineHeight,
      padding: cf.padding,
      bold: cf.bold,
      italic: cf.italic,
      underline: cf.underline,
    },
  };
}

function normalizeTargets(raw: unknown): Target[] {
  return (Array.isArray(raw) ? (raw as Target[]) : []).map((t) => ({
    name: t.name,
    defaultLanguage: t.defaultLanguage,
    requiresMetadata: t.requiresMetadata,
  }));
}

// Persist only the non-secret config shape; an `apiKey` (or any stray field) from
// a legacy file is never written back into the git-versionable workspace.
function normalizeAiConfigs(raw: unknown): StoredAiConfig[] {
  return (Array.isArray(raw) ? (raw as StoredAiConfig[]) : []).map((c) => ({
    id: c.id,
    name: c.name,
    provider: c.provider,
    model: c.model,
  }));
}

function normalizeAnalysisPrompts(raw: unknown): AnalysisPrompt[] {
  return (Array.isArray(raw) ? (raw as AnalysisPrompt[]) : []).map((p) => ({ name: p.name, text: p.text }));
}

function normalizeGenerationPrompts(raw: unknown): GenerationPromptsData {
  const src = asObject(asObject(raw).prompts);
  const prompts: Record<string, string> = {};
  for (const key of GENERATION_PROMPT_KEYS) {
    if (typeof src[key] === "string") prompts[key] = src[key] as string;
  }
  return { prompts };
}

// Build the whole config in modal order: schemaVersion, general settings, then
// targets, aiConfigs, analysisPrompts, generationPrompts.
function normalizeConfig(raw: unknown): WorkspaceConfig {
  const o = asObject(raw);
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    ...normalizeSettings(o),
    targets: normalizeTargets(o.targets),
    aiConfigs: normalizeAiConfigs(o.aiConfigs),
    analysisPrompts: normalizeAnalysisPrompts(o.analysisPrompts),
    generationPrompts: normalizeGenerationPrompts(o.generationPrompts),
  };
}

// --- the single config file ---------------------------------------------------

function readConfig(dataDir: string): WorkspaceConfig {
  const raw = fs.readFileSync(path.join(dataDir, CONFIG_FILE), "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${CONFIG_FILE} is not valid JSON.`, { cause });
  }
  return normalizeConfig(parsed);
}

function writeConfig(dataDir: string, config: WorkspaceConfig): void {
  // recorded: a workspace's config.json is its durable, user-authored settings (targets, AI configs,
  // analysis/generation prompts). It is managed text under a workspace's data directory — internal or
  // at a user-chosen absolute path — and carries no secret (keys live in api-keys.json), so it is
  // recorded on every save (data-backup conventions: config.json is recorded).
  writeManagedText(path.join(dataDir, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n");
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

export function saveSettings(dataDir: string, settings: Settings): Settings {
  const config = readConfig(dataDir);
  const normalized = normalizeSettings(settings);
  writeConfig(dataDir, { ...config, ...normalized });
  return normalized;
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
    { id: input.id, name: input.name, provider: input.provider, model: input.model },
  ];
  // Config first, then key: the key is only meaningful once its config exists, so
  // a failed key write at worst leaves a keyless config the user can re-key. (The
  // workspace file and the secrets file are separate; they cannot be made atomic
  // without machinery, so ordering bounds the blast radius instead.)
  writeConfig(workspace.dataDirectory, config);
  if (input.apiKey !== undefined) {
    apiKeys.writeApiKey(getApiKeysPath(), workspace.id, input.id, input.provider, input.apiKey);
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
  const config = readConfig(workspace.dataDirectory);
  const target = config.aiConfigs.find((c) => c.id === id);
  if (!target) {
    throw new Error(`AI config with id "${id}" not found`);
  }
  const metadataChanged =
    patch.name !== undefined || patch.provider !== undefined || patch.model !== undefined;
  if (patch.name !== undefined) target.name = patch.name;
  if (patch.provider !== undefined) target.provider = patch.provider;
  if (patch.model !== undefined) target.model = patch.model;
  // Key to the secrets file first, so a failure there leaves the workspace file
  // untouched. Rewrite the workspace file only when a non-secret field changed —
  // a key-only edit must not dirty the git-versioned config.json.
  if (patch.apiKey !== undefined) {
    apiKeys.writeApiKey(getApiKeysPath(), workspace.id, id, target.provider, patch.apiKey);
  }
  if (metadataChanged) {
    writeConfig(workspace.dataDirectory, config);
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
  writeConfig(workspace.dataDirectory, config);
  apiKeys.clearApiKey(getApiKeysPath(), workspace.id, id);
  return getAiConfigsForClient(workspace);
}

/**
 * Selects the active AI config for this session (not persisted). Accepts an empty
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
  const config = readConfig(dataDir);
  const normalized = normalizeTargets(targets);
  writeConfig(dataDir, { ...config, targets: normalized });
  return normalized;
}

// --- Analysis Prompts ---------------------------------------------------------

export function getAnalysisPrompts(dataDir: string): AnalysisPrompt[] {
  return readConfig(dataDir).analysisPrompts;
}

export function saveAnalysisPrompts(dataDir: string, prompts: AnalysisPrompt[]): AnalysisPrompt[] {
  const config = readConfig(dataDir);
  const normalized = normalizeAnalysisPrompts(prompts);
  writeConfig(dataDir, { ...config, analysisPrompts: normalized });
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
  const config = readConfig(dataDir);
  const normalized = normalizeGenerationPrompts(data);
  writeConfig(dataDir, { ...config, generationPrompts: normalized });
  return normalized;
}
