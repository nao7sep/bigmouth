/** Workspace settings are read and written by whole set. Secrets and selection have separate owners. */

import fs from "node:fs";
import path from "node:path";
import type {
  Settings,
  Target,
  AnalysisPrompt,
  GenerationPromptsData,
  WorkspaceConfig,
  Workspace,
} from "../shared/types.js";
import type { AnthropicSettings, AnthropicSettingsInput, AnthropicSettingsView } from "@shared/types";
import {
  SETTINGS_SET_KEYS,
  WORKSPACE_SET_KEYS,
  modelSetKey,
  setsDifferingFromBuiltIn,
  thinkingSetKey,
  workspaceSetIssue,
} from "@shared/configSets";
import { AI_ROLE_IDS, thinkingFor, type AiRole } from "@shared/aiModels";
import { isWorkspaceConfig } from "../shared/workspaceConfigShape.js";
import { writeSetFile } from "../shared/setFile.js";
import { anthropicSets, makeDefaultConfig } from "../shared/defaults.js";
import { warn } from "./logger.js";
import * as apiKeys from "./apiKeys.js";
import { getApiKeysPath } from "./storagePaths.js";

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

// --- The Anthropic section ----------------------------------------------------

function anthropicSection(config: WorkspaceConfig): AnthropicSettings {
  const models = {} as Record<AiRole, string>;
  const thinking = {} as Record<AiRole, string>;
  for (const role of AI_ROLE_IDS) {
    models[role] = config[modelSetKey(role)];
    thinking[role] = config[thinkingSetKey(role)];
  }
  return { endpoint: config["anthropic.endpoint"], models, thinking };
}

/** What one role's call is built from. For main-process use only: it carries the plaintext key. */
export interface RoleCall {
  endpoint: string;
  model: string;
  /** The value the role sends; undefined for a model with no row, which sends none. */
  thinking: string | undefined;
  apiKey: string | null;
}

/**
 * One role's endpoint, model and thinking, with the workspace's key resolved
 * (environment first, then the storage-root secrets file — never the
 * workspace). NEVER send the result to the renderer.
 */
export function getRoleCall(workspace: Workspace, role: AiRole): RoleCall {
  const section = anthropicSection(readConfig(workspace.dataDirectory));
  const model = section.models[role];
  return {
    endpoint: section.endpoint,
    model,
    thinking: thinkingFor(model, section.thinking[role]),
    apiKey: apiKeys.resolveApiKey(getApiKeysPath(), workspace.id, "anthropic"),
  };
}

/**
 * The section for the renderer: each role's thinking as the value it sends (a
 * model with no row keeps the stored one), and whether a key is stored or the
 * environment overrides it. The key value never crosses the IPC bridge.
 */
export function getAnthropicSettingsForClient(workspace: Workspace): AnthropicSettingsView {
  const section = anthropicSection(readConfig(workspace.dataDirectory));
  const thinking = {} as Record<AiRole, string>;
  for (const role of AI_ROLE_IDS) {
    thinking[role] = thinkingFor(section.models[role], section.thinking[role]) ?? section.thinking[role];
  }
  return {
    ...section,
    thinking,
    hasApiKey: apiKeys.hasStoredApiKey(getApiKeysPath(), workspace.id, "anthropic"),
    usingEnvKey: apiKeys.hasEnvApiKey("anthropic"),
  };
}

/**
 * Saves the section's sets, trimmed, and a key the user typed. The key goes to
 * the secrets file first, so a failure there leaves the workspace file untouched;
 * a blank key keeps the stored one.
 */
export function saveAnthropicSettings(workspace: Workspace, input: AnthropicSettingsInput): AnthropicSettingsView {
  if (input.apiKey?.trim()) apiKeys.writeApiKey(getApiKeysPath(), workspace.id, "anthropic", input.apiKey);
  const models = {} as Record<AiRole, string>;
  for (const role of AI_ROLE_IDS) models[role] = input.models[role].trim();
  writeSets(workspace.dataDirectory, anthropicSets({ endpoint: input.endpoint.trim(), models, thinking: input.thinking }));
  return getAnthropicSettingsForClient(workspace);
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
