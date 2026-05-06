/**
 * JSON config file I/O for settings, targets, and prompts.
 *
 * All public functions take a dataDir parameter (the workspace data directory).
 */

import fs from "node:fs";
import path from "node:path";
import type { Settings, Target, AnalysisPrompt, AiConfigsData, GenerationPromptsData } from "../shared/types.js";
import { obfuscate, deobfuscate } from "../shared/obfuscation.js";

// --- Settings ---

export function getSettings(dataDir: string): Settings {
  const raw = fs.readFileSync(path.join(dataDir, "settings.json"), "utf-8");
  return JSON.parse(raw) as Settings;
}

export function saveSettings(dataDir: string, settings: Settings): void {
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
}

// --- AI Configs ---

/**
 * Masking sentinel for API keys sent to the client.
 *
 * The plaintext key is never returned over HTTP. Instead, a string of bullet
 * characters followed by the last four characters of the key is returned so
 * the UI can display "key is set". On save, any incoming key starting with
 * MASK_PREFIX is treated as "leave the existing key unchanged".
 *
 * The bullet character (U+2022) is not a valid leading character in any
 * provider's API key format, so this sentinel is unambiguous.
 */
const MASK_PREFIX = "••••";

function maskKey(plain: string): string {
  if (!plain) return "";
  const tail = plain.length >= 4 ? plain.slice(-4) : plain;
  return MASK_PREFIX + tail;
}

function isMasked(value: string): boolean {
  return typeof value === "string" && value.startsWith(MASK_PREFIX);
}

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
 * Returns AI configs with API keys masked. Safe to send to the client.
 */
export function getAiConfigsForClient(dataDir: string): AiConfigsData {
  const data = readAiConfigsRaw(dataDir);
  for (const config of data.configs ?? []) {
    if (config.apiKey) {
      config.apiKey = maskKey(deobfuscate(config.apiKey));
    }
  }
  return data;
}

/**
 * Persists AI configs. Any incoming config whose apiKey is masked (i.e. the
 * client did not edit it) keeps its existing stored key.
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

  const toWrite = structuredClone(data);
  for (const config of toWrite.configs ?? []) {
    if (isMasked(config.apiKey)) {
      // Preserve the previously stored (already-obfuscated) key as-is.
      const prev = existingById.get(config.id);
      config.apiKey = prev?.apiKey ?? "";
    } else if (config.apiKey) {
      config.apiKey = obfuscate(config.apiKey);
    }
  }
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
  return JSON.parse(raw) as GenerationPromptsData;
}

export function saveGenerationPrompts(dataDir: string, data: GenerationPromptsData): void {
  fs.writeFileSync(path.join(dataDir, "generation-prompts.json"), JSON.stringify(data, null, 2) + "\n");
}
