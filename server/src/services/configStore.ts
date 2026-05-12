/**
 * JSON config file I/O for settings, targets, and prompts.
 *
 * All public functions take a dataDir parameter (the workspace data directory).
 */

import fs from "node:fs";
import path from "node:path";
import type { Settings, Target, AnalysisPrompt, AiConfigsData, GenerationPromptsData } from "../shared/types.js";
import { obfuscate, deobfuscate } from "../shared/obfuscation.js";
import { normalizeGenerationPromptsData } from "../ai/generationPrompts.js";

// --- Settings ---

export function getSettings(dataDir: string): Settings {
  const raw = fs.readFileSync(path.join(dataDir, "settings.json"), "utf-8");
  return JSON.parse(raw) as Settings;
}

export function saveSettings(dataDir: string, settings: Settings): void {
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
}

// --- AI Configs ---

function readAiConfigsRaw(dataDir: string): AiConfigsData {
  const raw = fs.readFileSync(path.join(dataDir, "ai-configs.json"), "utf-8");
  return JSON.parse(raw) as AiConfigsData;
}

/**
 * Returns AI configs with API keys deobfuscated. For server-internal use only
 * (analysis, generation). NEVER send the result of this function to the client.
 */
export function getAiConfigsForServer(dataDir: string): AiConfigsData {
  const data = readAiConfigsRaw(dataDir);
  for (const config of data.configs ?? []) {
    if (config.apiKey) {
      config.apiKey = deobfuscate(config.apiKey);
    }
  }
  return data;
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

/**
 * Persists AI configs. When the client sends an empty API key with
 * hasApiKey=true, the previously stored key is preserved.
 */
export function saveAiConfigs(dataDir: string, data: AiConfigsData): void {
  const existing = (() => {
    try {
      return readAiConfigsRaw(dataDir);
    } catch {
      return { configs: [], activeId: "" } as AiConfigsData;
    }
  })();
  const existingById = new Map(existing.configs?.map((c) => [c.id, c]) ?? []);

  const toWrite: AiConfigsData = {
    activeId: data.activeId,
    configs: (data.configs ?? []).map((config) => {
      const prev = existingById.get(config.id);
      const apiKey = config.apiKey
        ? obfuscate(config.apiKey)
        : config.hasApiKey
          ? (prev?.apiKey ?? "")
          : "";
      return {
        id: config.id,
        name: config.name,
        provider: config.provider,
        apiKey,
        model: config.model,
      };
    }),
  };
  fs.writeFileSync(path.join(dataDir, "ai-configs.json"), JSON.stringify(toWrite, null, 2) + "\n");
}

// --- Targets ---

export function getTargets(dataDir: string): Target[] {
  const raw = fs.readFileSync(path.join(dataDir, "targets.json"), "utf-8");
  return JSON.parse(raw) as Target[];
}

export function saveTargets(dataDir: string, targets: Target[]): void {
  fs.writeFileSync(path.join(dataDir, "targets.json"), JSON.stringify(targets, null, 2) + "\n");
}

// --- Analysis Prompts ---

export function getAnalysisPrompts(dataDir: string): AnalysisPrompt[] {
  const raw = fs.readFileSync(path.join(dataDir, "analysis-prompts.json"), "utf-8");
  return JSON.parse(raw) as AnalysisPrompt[];
}

export function saveAnalysisPrompts(dataDir: string, prompts: AnalysisPrompt[]): void {
  fs.writeFileSync(path.join(dataDir, "analysis-prompts.json"), JSON.stringify(prompts, null, 2) + "\n");
}

// --- Generation Prompts ---

export function getGenerationPrompts(dataDir: string): GenerationPromptsData {
  const raw = fs.readFileSync(path.join(dataDir, "generation-prompts.json"), "utf-8");
  const parsed = JSON.parse(raw) as GenerationPromptsData;
  const normalized = normalizeGenerationPromptsData(parsed);
  if (normalized.changed) {
    saveGenerationPrompts(dataDir, normalized.data);
  }
  return normalized.data;
}

export function saveGenerationPrompts(dataDir: string, data: GenerationPromptsData): void {
  const normalized = normalizeGenerationPromptsData(data);
  fs.writeFileSync(
    path.join(dataDir, "generation-prompts.json"),
    JSON.stringify(normalized.data, null, 2) + "\n"
  );
}
