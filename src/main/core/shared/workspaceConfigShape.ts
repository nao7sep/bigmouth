/** Identifies a supported BigMouth workspace config without depending on services. */

import { CONFIG_SCHEMA_VERSION } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isWorkspaceConfig(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    Number.isInteger(value.schemaVersion) &&
    (value.schemaVersion as number) >= 1 &&
    (value.schemaVersion as number) <= CONFIG_SCHEMA_VERSION &&
    Array.isArray(value.aiConfigs) &&
    Array.isArray(value.targets) &&
    Array.isArray(value.analysisPrompts) &&
    isObject(value.generationPrompts)
  );
}
