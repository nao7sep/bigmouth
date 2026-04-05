/**
 * JSON config file I/O for settings, targets, and prompts.
 */

import fs from "node:fs";
import path from "node:path";
import type { Settings, Target, Prompt } from "../shared/types.js";
import { obfuscate, deobfuscate } from "../shared/obfuscation.js";

let dataDir = "";

export function initConfigStore(dataDirectory: string): void {
  dataDir = dataDirectory;
}

// --- Settings ---

export function getSettings(): Settings {
  const raw = fs.readFileSync(settingsPath(), "utf-8");
  const settings = JSON.parse(raw) as Settings;

  // Deobfuscate API key for in-memory use
  if (settings.ai?.apiKey) {
    settings.ai.apiKey = deobfuscate(settings.ai.apiKey);
  }

  return settings;
}

export function saveSettings(settings: Settings): void {
  // Obfuscate API key before writing to disk
  const toWrite = structuredClone(settings);
  if (toWrite.ai?.apiKey) {
    toWrite.ai.apiKey = obfuscate(toWrite.ai.apiKey);
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
