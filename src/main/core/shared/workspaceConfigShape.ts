/** Identifies a supported BigMouth workspace config without depending on services. */

import { CONFIG_SCHEMA_VERSION } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isWorkspaceConfig(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    value.schemaVersion === CONFIG_SCHEMA_VERSION &&
    Array.isArray(value.aiConfigs) &&
    Array.isArray(value.targets) &&
    Array.isArray(value.analysisPrompts) &&
    isObject(value.generationPrompts)
  );
}
