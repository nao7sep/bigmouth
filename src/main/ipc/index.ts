import { registerWorkspaceHandlers } from "./workspaces.js";
import { registerLogHandlers } from "./logs.js";
import { registerSettingsHandlers } from "./settings.js";
import { registerTargetHandlers } from "./targets.js";
import { registerPostHandlers } from "./posts.js";
import { registerAiConfigHandlers } from "./aiConfigs.js";
import { registerAnalysisPromptHandlers } from "./analysisPrompts.js";
import { registerGenerationPromptHandlers } from "./generationPrompts.js";
import { registerMetadataHandlers } from "./metadata.js";
import { registerImagingHandlers } from "./imaging.js";
import { registerAssetHandlers } from "./assets.js";
import { registerAnalysisHandlers } from "./analysis.js";
import { registerDialogHandlers } from "./dialog.js";

/**
 * Registers every ipcMain handler. Called once at startup. Domains are added
 * here as they are ported from the old Express routers.
 */
export function registerIpcHandlers(): void {
  registerWorkspaceHandlers();
  registerLogHandlers();
  registerSettingsHandlers();
  registerTargetHandlers();
  registerPostHandlers();
  registerAiConfigHandlers();
  registerAnalysisPromptHandlers();
  registerGenerationPromptHandlers();
  registerMetadataHandlers();
  registerImagingHandlers();
  registerAssetHandlers();
  registerAnalysisHandlers();
  registerDialogHandlers();
}
