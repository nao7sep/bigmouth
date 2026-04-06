/**
 * JSON config file I/O for settings, targets, and prompts.
 */

import fs from "node:fs";
import path from "node:path";
import type { Settings, Target, Prompt } from "../shared/types.js";
import { obfuscate, deobfuscate } from "../shared/obfuscation.js";
import { DEFAULT_GENERATION_PROMPTS, DEFAULT_GENERATION_PREAMBLE } from "../ai/generatePrompts.js";

let dataDir = "";

export function initConfigStore(dataDirectory: string): void {
  dataDir = dataDirectory;
}

// --- Settings ---

export function getSettings(): Settings {
  const raw = fs.readFileSync(settingsPath(), "utf-8");
  const settings = JSON.parse(raw) as Settings;

  // Deobfuscate API keys for in-memory use
  for (const config of settings.aiConfigs ?? []) {
    if (config.apiKey) {
      config.apiKey = deobfuscate(config.apiKey);
    }
  }

  // Back-fill any missing generation prompt keys (forward-compat for older installs)
  settings.generationPrompts = {
    ...DEFAULT_GENERATION_PROMPTS,
    ...(settings.generationPrompts ?? {}),
  };
  if (!settings.generationPreamble) {
    settings.generationPreamble = DEFAULT_GENERATION_PREAMBLE;
  }

  return settings;
}

export function saveSettings(settings: Settings): void {
  // Obfuscate API keys before writing to disk
  const toWrite = structuredClone(settings);
  for (const config of toWrite.aiConfigs ?? []) {
    if (config.apiKey) {
      config.apiKey = obfuscate(config.apiKey);
    }
  }

  fs.writeFileSync(settingsPath(), JSON.stringify(toWrite, null, 2) + "\n");
}

// --- Targets ---

export function getTargets(): Target[] {
  const raw = fs.readFileSync(targetsPath(), "utf-8");
  return JSON.parse(raw) as Target[];
}

export function saveTargets(targets: Target[]): void {
  fs.writeFileSync(targetsPath(), JSON.stringify(targets, null, 2) + "\n");
}

// --- Prompts ---

export function getPrompts(): Prompt[] {
  const raw = fs.readFileSync(promptsPath(), "utf-8");
  return JSON.parse(raw) as Prompt[];
}

export function savePrompts(prompts: Prompt[]): void {
  fs.writeFileSync(promptsPath(), JSON.stringify(prompts, null, 2) + "\n");
}

// --- Paths ---

function settingsPath(): string {
  return path.join(dataDir, "settings.json");
}

function targetsPath(): string {
  return path.join(dataDir, "targets.json");
}

function promptsPath(): string {
  return path.join(dataDir, "prompts.json");
}
