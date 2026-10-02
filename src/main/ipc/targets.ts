import { ipcMain } from "electron";

import { CHANNELS, type TargetRenameResult } from "@shared/ipc";
import type { Target } from "@shared/types";
import { workspaceSetIssue } from "@shared/configSets";
import { getTargets, saveTargets } from "../core/services/configStore.js";
import { renameTarget } from "../core/services/postStore.js";
import { info } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

export function registerTargetHandlers(): void {
  ipcMain.handle(CHANNELS.listTargets, (_event, wsId: string) => {
    const ws = resolveWorkspace(wsId);
    const targets = getTargets(ws.dataDirectory);
    info("targets loaded", { workspace: ws.id, count: targets.length });
    return targets;
  });

  ipcMain.handle(CHANNELS.saveTargets, (_event, wsId: string, body: unknown) => {
    const ws = resolveWorkspace(wsId);
    const issue = workspaceSetIssue("targets", body);
    if (issue !== null) throw new Error(issue);
    const targets = saveTargets(ws.dataDirectory, body as Target[]);
    info("targets saved", { workspace: ws.id, count: targets.length });
    return targets;
  });

  ipcMain.handle(CHANNELS.renameTarget, (_event, wsId: string, oldName: string, newName: string) => {
    const ws = resolveWorkspace(wsId);
    if (typeof oldName !== "string" || typeof newName !== "string" || !oldName.trim() || !newName.trim()) {
      throw new Error("oldName and newName are required");
    }
    const normalizedOldName = oldName.trim();
    const normalizedNewName = newName.trim();

    const targets = getTargets(ws.dataDirectory);
    const target = targets.find((t) => t.name === normalizedOldName);
    if (!target) {
      throw new Error("Target not found");
    }
    if (targets.some((t) => t.name === normalizedNewName && t.name !== normalizedOldName)) {
      throw new Error("A target with that name already exists");
    }

    // Posts first, the target list last: a rename that fails partway leaves the
    // old target in place, so the posts still on it keep a valid target and the
    // same rename can be run again.
    const renamed = renameTarget(ws.dataDirectory, normalizedOldName, normalizedNewName);
    target.name = normalizedNewName;
    const savedTargets = saveTargets(ws.dataDirectory, targets);

    info("target renamed", {
      workspace: ws.id,
      oldName: normalizedOldName,
      newName: normalizedNewName,
      postsUpdated: renamed.updated,
      postsSkipped: renamed.skipped.length,
    });
    const result: TargetRenameResult = {
      targets: savedTargets,
      postsUpdated: renamed.updated,
      postsSkipped: renamed.skipped,
    };
    return result;
  });
}
