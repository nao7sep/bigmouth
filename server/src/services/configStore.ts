/**
 * JSON config file I/O for settings, targets, and prompts.
 */

import fs from "node:fs";
import path from "node:path";
import type { Settings, Target, AnalysisPrompt, AiConfigsData, GenerationPromptsData } from "../shared/types.js";
import { obfuscate, deobfuscate } from "../shared/obfuscation.js";

let dataDir = "";

export function initConfigStore(dataDirectory: string): void {
  dataDir = dataDirectory;
}

// --- Settings ---

export function getSettings(): Settings {
  const raw = fs.readFileSync(settingsPath(), "utf-8");
  return JSON.parse(raw) as Settings;
}

export function saveSettings(settings: Settings): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + "\n");
}

// --- AI Configs ---

export function getAiConfigs(): AiConfigsData {
  const raw = fs.readFileSync(aiConfigsPath(), "utf-8");
  const data = JSON.parse(raw) as AiConfigsData;

  for (const config of data.configs ?? []) {
    if (config.apiKey) {
      config.apiKey = deobfuscate(config.apiKey);
    }
  }

  return data;
}

export function saveAiConfigs(data: AiConfigsData): void {
  const toWrite = structuredClone(data);
  for (const config of toWrite.configs ?? []) {
    if (config.apiKey) {
      config.apiKey = obfuscate(config.apiKey);
    }
  }
  fs.writeFileSync(aiConfigsPath(), JSON.stringify(toWrite, null, 2) + "\n");
}

// --- Targets ---

export function getTargets(): Target[] {
  const raw = fs.readFileSync(targetsPath(), "utf-8");
  return JSON.parse(raw) as Target[];
}

export function saveTargets(targets: Target[]): void {
  fs.writeFileSync(targetsPath(), JSON.stringify(targets, null, 2) + "\n");
}

// --- Analysis Prompts ---

export function getAnalysisPrompts(): AnalysisPrompt[] {
  const raw = fs.readFileSync(promptsPath(), "utf-8");
  return JSON.parse(raw) as AnalysisPrompt[];
}

export function saveAnalysisPrompts(prompts: AnalysisPrompt[]): void {
  fs.writeFileSync(promptsPath(), JSON.stringify(prompts, null, 2) + "\n");
}

// --- Generation Prompts ---

export function getGenerationPrompts(): GenerationPromptsData {
  const raw = fs.readFileSync(generationPromptsPath(), "utf-8");
  return JSON.parse(raw) as GenerationPromptsData;
}

export function saveGenerationPrompts(data: GenerationPromptsData): void {
  fs.writeFileSync(generationPromptsPath(), JSON.stringify(data, null, 2) + "\n");
}

// --- Paths ---

function settingsPath(): string {
  return path.join(dataDir, "settings.json");
}

function aiConfigsPath(): string {
  return path.join(dataDir, "ai-configs.json");
}

function targetsPath(): string {
  return path.join(dataDir, "targets.json");
}

function promptsPath(): string {
  return path.join(dataDir, "analysis-prompts.json");
}

function generationPromptsPath(): string {
  return path.join(dataDir, "generation-prompts.json");
}
