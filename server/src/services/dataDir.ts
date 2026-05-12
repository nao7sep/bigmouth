/**
 * Workspace data directory initialization.
 *
 * Creates the initial workspace data directory structure and default config
 * files for a new workspace.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, DEFAULT_ANALYSIS_PROMPTS, DEFAULT_AI_CONFIGS, DEFAULT_GENERATION_PROMPTS_DATA } from "../shared/defaults.js";
import type { Target } from "../shared/types.js";

/**
 * Creates the workspace data directory and default files for a new workspace.
 */
export function initializeWorkspaceData(dataDir: string): void {
  for (const sub of [
    "posts/drafts",
    "posts/ready",
    "posts/published",
    "assets",
  ]) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }

  writeIfMissing(
    path.join(dataDir, "settings.json"),
    JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n"
  );

  writeIfMissing(
    path.join(dataDir, "ai-configs.json"),
    JSON.stringify(DEFAULT_AI_CONFIGS, null, 2) + "\n"
  );

  writeIfMissing(
    path.join(dataDir, "generation-prompts.json"),
    JSON.stringify(DEFAULT_GENERATION_PROMPTS_DATA, null, 2) + "\n"
  );

  const emptyTargets: Target[] = [];
  writeIfMissing(
    path.join(dataDir, "targets.json"),
    JSON.stringify(emptyTargets, null, 2) + "\n"
  );

  writeIfMissing(
    path.join(dataDir, "analysis-prompts.json"),
    JSON.stringify(DEFAULT_ANALYSIS_PROMPTS, null, 2) + "\n"
  );
}

function writeIfMissing(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}
