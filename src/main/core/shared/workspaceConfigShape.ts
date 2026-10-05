import { WORKSPACE_SET_KEYS } from "@shared/configSets";
import { FORMAT_VERSION_KEY } from "./storeFormat.js";

/**
 * A workspace config is a sparse map of user-edited sets beside its format
 * version: no set at all, or at least one known set key. Any other object is
 * another program's file, and the next settings write would drop its keys.
 */
export function isWorkspaceConfig(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).filter((key) => key !== FORMAT_VERSION_KEY);
  return keys.length === 0 || keys.some((key) => (WORKSPACE_SET_KEYS as readonly string[]).includes(key));
}
