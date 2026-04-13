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

export function getAiConfigs(dataDir: string): AiConfigsData {
  const raw = fs.readFileSync(path.join(dataDir, "ai-configs.json"), "utf-8");
  const data = JSON.parse(raw) as AiConfigsData;

  for (const config of data.configs ?? []) {
    if (config.apiKey) {
      config.apiKey = deobfuscate(config.apiKey);
    }
  }

  return data;
}

export function saveAiConfigs(dataDir: string, data: AiConfigsData): void {
  const toWrite = structuredClone(data);
  for (const config of toWrite.configs ?? []) {
    if (config.apiKey) {
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
