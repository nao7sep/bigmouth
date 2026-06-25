import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import type { Target } from "@shared/types";
import { getTargets, saveTargets } from "../core/services/configStore.js";
import { renameTarget } from "../core/services/postStore.js";
import { info } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

// Mirrors the old PUT /targets validation, throwing instead of returning 400.
function validateTargets(body: unknown): Target[] {
  if (!Array.isArray(body)) {
    throw new Error("targets must be an array");
  }
  for (const target of body) {
    if (!target || typeof target !== "object") {
      throw new Error("each target must be an object");
    }
    const t = target as Record<string, unknown>;
    if (typeof t.name !== "string" || !t.name.trim()) {
      throw new Error("each target needs a non-empty name");
    }
    if (typeof t.defaultLanguage !== "string") {
      throw new Error("each target needs a defaultLanguage string");
    }
    if (typeof t.requiresMetadata !== "boolean") {
      throw new Error("each target needs a boolean requiresMetadata");
    }
  }
  return body as Target[];
}

export function registerTargetHandlers(): void {
  ipcMain.handle(CHANNELS.listTargets, (_event, wsId: string) => {
    const ws = resolveWorkspace(wsId);
    const targets = getTargets(ws.dataDirectory);
    info("targets loaded", { workspace: ws.id, count: targets.length });
    return targets;
  });

  ipcMain.handle(CHANNELS.saveTargets, (_event, wsId: string, body: unknown) => {
    const ws = resolveWorkspace(wsId);
    const validated = validateTargets(body);
    const targets = saveTargets(ws.dataDirectory, validated);
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

    target.name = normalizedNewName;
    const savedTargets = saveTargets(ws.dataDirectory, targets);
    const postsUpdated = renameTarget(ws.dataDirectory, normalizedOldName, normalizedNewName);

    info("target renamed", {
      workspace: ws.id,
      oldName: normalizedOldName,
      newName: normalizedNewName,
      postsUpdated,
    });
    return { targets: savedTargets, postsUpdated };
  });
}
