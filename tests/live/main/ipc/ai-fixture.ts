import path from "node:path";
import { createWorkspace } from "@main/core/services/workspaceStore.js";

/** beforeAll runs before the per-test home hook, so its location must be explicit. */
export function createLiveWorkspace(root: string) {
  return createWorkspace("Live", path.join(root, "workspace"));
}
