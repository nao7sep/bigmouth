/**
 * Workspace data directory initialization.
 *
 * Creates the initial workspace data directory structure and default config
 * files for a new workspace.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, DEFAULT_ANALYSIS_PROMPTS, makeDefaultAiConfigs, DEFAULT_GENERATION_PROMPTS_DATA } from "../shared/defaults.js";
import { writeFileAtomic } from "../shared/atomicWrite.js";
import type { Target } from "../shared/types.js";

/**
 * Creates the workspace data directory and default files for a new workspace.
 */
export function initializeWorkspaceData(dataDir: string): void {
  for (const sub of ["posts", "assets"]) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }

  writeWorkspaceFile(
    path.join(dataDir, "settings.json"),
    JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n"
  );

  writeWorkspaceFile(
    path.join(dataDir, "ai-configs.json"),
    JSON.stringify(makeDefaultAiConfigs(), null, 2) + "\n"
  );

  writeWorkspaceFile(
    path.join(dataDir, "generation-prompts.json"),
    JSON.stringify(DEFAULT_GENERATION_PROMPTS_DATA, null, 2) + "\n"
  );

  const emptyTargets: Target[] = [];
  writeWorkspaceFile(
    path.join(dataDir, "targets.json"),
    JSON.stringify(emptyTargets, null, 2) + "\n"
  );

  writeWorkspaceFile(
    path.join(dataDir, "analysis-prompts.json"),
    JSON.stringify(DEFAULT_ANALYSIS_PROMPTS, null, 2) + "\n"
  );
}

function writeWorkspaceFile(filePath: string, content: string): void {
  writeFileAtomic(filePath, content);
}
