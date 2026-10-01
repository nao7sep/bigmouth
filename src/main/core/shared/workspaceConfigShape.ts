/** A workspace config is a sparse map of user-edited sets. */
export function isWorkspaceConfig(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
