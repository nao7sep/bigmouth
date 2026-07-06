/**
 * Workspace data directory initialization.
 *
 * Creates the data directory and the single default `config.json` for a new
 * workspace, plus the `posts/` and `assets/` subdirectories.
 */

import fs from "node:fs";
import path from "node:path";
import { makeDefaultConfig } from "../shared/defaults.js";
import { writeManagedText } from "../shared/atomicWrite.js";

export function initializeWorkspaceData(dataDir: string): void {
  for (const sub of ["posts", "assets"]) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
  // recorded: this is a workspace's FIRST config.json write, at creation. It is the same durable
  // managed text as every later config save (configStore.writeConfig), so it goes through the same
  // managed-text choke point — capturing the workspace from its very first version (data-backup
  // conventions: every file's first write is captured, so the history is complete through normal use).
  writeManagedText(
    path.join(dataDir, "config.json"),
    JSON.stringify(makeDefaultConfig(), null, 2) + "\n"
  );
}
