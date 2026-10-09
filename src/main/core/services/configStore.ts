/** Workspace settings are read and written by whole set. Secrets and selection have separate owners. */

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
  keptStoredSets,
  modelSetKey,
  setsDifferingFromBuiltIn,
  thinkingSetKey,
  workspaceSetIssue,
  type WorkspaceSetKey,
} from "@shared/configSets";
import { AI_ROLE_IDS, rowFor, thinkingFor, type AiRole } from "@shared/aiModels";
import { message, type Message } from "@shared/i18n/translate";
import { writeSetFile } from "../shared/setFile.js";
import { NewerFormatError, UnreadableStoreError, readJsonStore } from "../shared/storeFormat.js";
import { anthropicSets, makeDefaultConfig } from "../shared/defaults.js";
import { warn } from "./logger.js";
import * as apiKeys from "./apiKeys.js";
import { getApiKeysPath } from "./storagePaths.js";

const CONFIG_FILE = "config.json";

function readMap(dataDir: string): Record<string, unknown> {
  const filePath = path.join(dataDir, CONFIG_FILE);
  const read = readJsonStore("workspaceConfig", filePath);
  switch (read.kind) {
    case "absent":
      return {};
    case "newer":
      throw new NewerFormatError(filePath, read.version);
    case "inaccessible":
    case "unreadable":
      throw new UnreadableStoreError(filePath, read.detail, read.error);
    case "read":
      // Every key is kept: sets this build does not know survive each save.
      return read.value;
  }
}

/** The config a stored map reads as, and each stored set that was invalid and read as its built-in. */
export function effectiveConfig(map: Record<string, unknown>): { config: WorkspaceConfig; issues: { key: WorkspaceSetKey; issue: string }[] } {
  const config = structuredClone(makeDefaultConfig());
  const issues: { key: WorkspaceSetKey; issue: string }[] = [];
  const stored = new Set<WorkspaceSetKey>();
  for (const key of WORKSPACE_SET_KEYS) {
    if (!Object.hasOwn(map, key)) continue;
    const issue = workspaceSetIssue(key, map[key]);
    if (issue === null) {
      Object.assign(config, { [key]: map[key] });
      stored.add(key);
    } else issues.push({ key, issue });
  }
  // The stored prompts are those the user changed; every other prompt, such as
  // one a later version added, reads as its built-in.
  if (stored.has("generationPrompts")) {
    const builtIn = makeDefaultConfig().generationPrompts.prompts;
    const own = config.generationPrompts.prompts as Record<string, unknown>;
    config.generationPrompts = {
      prompts: Object.fromEntries(Object.entries(builtIn).map(([key, text]) => [key, typeof own[key] === "string" ? own[key] : text])),
    } as GenerationPromptsData;
  }
  // A thinking is stored only while it differs from the selected model's own default,
  // so one the file does not hold is that row's default, not the role's built-in
  // (which belongs to the role's default model). An id with no row keeps the built-in.
  for (const role of AI_ROLE_IDS) {
    const row = rowFor(config[modelSetKey(role)]);
    if (row && !stored.has(thinkingSetKey(role))) config[thinkingSetKey(role)] = row.defaultThinking;
  }
  return { config, issues };
}

function readConfig(dataDir: string): WorkspaceConfig {
  const { config, issues } = effectiveConfig(readMap(dataDir));
  for (const { key, issue } of issues) {
    warn("workspace config set is invalid; using built-in", { path: path.join(dataDir, CONFIG_FILE), key, issue });
  }
  return config;
}

/**
 * Writes the sets that differ from their built-ins (config-sets-conventions),
 * keeping as stored every set this build cannot use that the save did not
 * change: an invalid set, read as its built-in, and a set another version wrote.
 */
function writeSets(dataDir: string, changes: Partial<WorkspaceConfig>): void {
  const stored = readMap(dataDir);
  const current = readConfig(dataDir);
  const builtIn = makeDefaultConfig();
  const sets = setsDifferingFromBuiltIn({ ...current, ...changes }, builtIn, WORKSPACE_SET_KEYS);
  // Prompts are stored sparse, only those the user changed, so a later
  // version's improved built-in reaches every prompt the user left alone.
  const prompts = (sets.generationPrompts as GenerationPromptsData | undefined)?.prompts;
  if (prompts) {
    sets.generationPrompts = {
      prompts: Object.fromEntries(Object.entries(prompts).filter(([key, text]) =>
        Object.hasOwn(builtIn.generationPrompts.prompts, key) && builtIn.generationPrompts.prompts[key] !== text)),
    };
  }
  const kept = keptStoredSets(
    stored,
    WORKSPACE_SET_KEYS,
    (key, value) => workspaceSetIssue(key as WorkspaceSetKey, value) === null,
    (key) => Object.hasOwn(changes, key) &&
      JSON.stringify(changes[key as keyof WorkspaceConfig]) !== JSON.stringify(current[key as keyof WorkspaceConfig]),
  );
  writeSetFile("workspaceConfig", path.join(dataDir, CONFIG_FILE), { ...sets, ...kept });
}

/** Where a workspace's stored settings could not all be used, or null when they could. */
export function getConfigNotice(dataDir: string): Message | null {
  const { issues } = effectiveConfig(readMap(dataDir));
  return issues.length > 0 ? message("session.settingsInvalid", { path: path.join(dataDir, CONFIG_FILE) }) : null;
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
    postsPerLoad: c.postsPerLoad,
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
    keyNotice: apiKeys.keyFileProblem(getApiKeysPath()),
  };
}

/**
 * Saves the section's sets, trimmed, and a key the user typed. The key goes to
 * the secrets file first, so a failure there leaves the workspace file untouched;
 * a blank key keeps the stored one. When saving the key set a damaged key file
 * aside, the returned notice says where it went.
 */
export function saveAnthropicSettings(workspace: Workspace, input: AnthropicSettingsInput): AnthropicSettingsView {
  const movedTo = input.apiKey?.trim() ? apiKeys.writeApiKey(getApiKeysPath(), workspace.id, "anthropic", input.apiKey) : null;
  const models = {} as Record<AiRole, string>;
  for (const role of AI_ROLE_IDS) models[role] = input.models[role].trim();
  writeSets(workspace.dataDirectory, anthropicSets({ endpoint: input.endpoint.trim(), models, thinking: input.thinking }));
  const view = getAnthropicSettingsForClient(workspace);
  return movedTo ? { ...view, keyNotice: message("settings.keyFileMovedAside", { path: movedTo }) } : view;
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
