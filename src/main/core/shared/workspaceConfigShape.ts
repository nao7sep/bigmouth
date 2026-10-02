import { WORKSPACE_SET_KEYS } from "@shared/configSets";

/**
 * A workspace config is a sparse map of user-edited sets: `{}`, or an object
 * holding at least one known set key. Any other object is another program's
 * file, and the next settings write would drop its keys.
 */
export function isWorkspaceConfig(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 0 || keys.some((key) => (WORKSPACE_SET_KEYS as readonly string[]).includes(key));
}
