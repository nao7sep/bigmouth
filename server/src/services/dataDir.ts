/**
 * Workspace data directory initialization.
 *
 * Ensures a workspace data directory has all required subdirectories
 * and default config files. Called when creating a new workspace.
 * Idempotent — only creates what is missing, never overwrites.
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, DEFAULT_ANALYSIS_PROMPTS, DEFAULT_AI_CONFIGS, DEFAULT_GENERATION_PROMPTS_DATA } from "../shared/defaults.js";
import type { Target } from "../shared/types.js";

/**
 * Ensures the workspace data directory and all required subdirectories
 * and default files exist. Only creates what is missing.
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
