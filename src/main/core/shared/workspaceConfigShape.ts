import { WORKSPACE_SET_KEYS } from "@shared/configSets";
import { FORMAT_VERSION_KEY } from "./storeFormat.js";

/**
 * Whether a `config.json` found beside posts/ and assets/ makes a folder being
 * opened a BigMouth workspace: no set at all, a format version BigMouth wrote,
 * or at least one known set key. Any other object is another program's file,
 * such as a static-site config, and opening the folder would add BigMouth's
 * sets to it. A workspace already in the list reads whatever its file holds.
 */
export function isWorkspaceConfig(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.hasOwn(value, FORMAT_VERSION_KEY)) return true;
  const keys = Object.keys(value);
  return keys.length === 0 || keys.some((key) => (WORKSPACE_SET_KEYS as readonly string[]).includes(key));
}
