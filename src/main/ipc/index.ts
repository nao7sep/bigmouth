import { registerWorkspaceHandlers } from "./workspaces.js";
import { registerLogHandlers } from "./logs.js";
import { registerSettingsHandlers } from "./settings.js";
import { registerTargetHandlers } from "./targets.js";

/**
 * Registers every ipcMain handler. Called once at startup. Domains are added
 * here as they are ported from the old Express routers.
 */
export function registerIpcHandlers(): void {
  registerWorkspaceHandlers();
  registerLogHandlers();
  registerSettingsHandlers();
  registerTargetHandlers();
}
