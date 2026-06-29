/**
 * Workspace data directory initialization.
 *
 * Creates the data directory and the single default `config.json` for a new
 * workspace, plus the `posts/` and `assets/` subdirectories.
 */

import fs from "node:fs";
import path from "node:path";
import { makeDefaultConfig } from "../shared/defaults.js";
import { writeFileAtomic } from "../shared/atomicWrite.js";

export function initializeWorkspaceData(dataDir: string): void {
  for (const sub of ["posts", "assets"]) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
  writeFileAtomic(
    path.join(dataDir, "config.json"),
    JSON.stringify(makeDefaultConfig(), null, 2) + "\n"
  );
}
