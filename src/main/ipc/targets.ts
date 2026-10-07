import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import type { Target } from "@shared/types";
import { workspaceSetIssue } from "@shared/configSets";
import { getTargets, saveTargets, renameTarget } from "../storageAccess.js";
import { info } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

export function registerTargetHandlers(): void {
  ipcMain.handle(CHANNELS.listTargets, async (_event, wsId: string) => {
    const ws = await resolveWorkspace(wsId);
    const targets = await getTargets(ws.dataDirectory);
    info("targets loaded", { workspace: ws.id, count: targets.length });
    return targets;
  });

  ipcMain.handle(CHANNELS.saveTargets, async (_event, wsId: string, body: unknown) => {
    const ws = await resolveWorkspace(wsId);
    const issue = workspaceSetIssue("targets", body);
    if (issue !== null) throw new Error(issue);
    const targets = await saveTargets(ws.dataDirectory, body as Target[]);
    info("targets saved", { workspace: ws.id, count: targets.length });
    return targets;
  });

  ipcMain.handle(CHANNELS.renameTarget, async (_event, wsId: string, oldName: string, newName: string) => {
    const ws = await resolveWorkspace(wsId);
    if (typeof oldName !== "string" || typeof newName !== "string" || !oldName.trim() || !newName.trim()) {
      throw new Error("oldName and newName are required");
    }
    const normalizedOldName = oldName.trim();
    const normalizedNewName = newName.trim();

    const result = await renameTarget(ws.dataDirectory, normalizedOldName, normalizedNewName);

    info("target renamed", {
      workspace: ws.id,
      oldName: normalizedOldName,
      newName: normalizedNewName,
      postsUpdated: result.postsUpdated,
      postsSkipped: result.postsSkipped.length,
    });
    return result;
  });
}
