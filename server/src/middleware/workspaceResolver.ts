/**
 * Express middleware that resolves a workspace ID from the route parameter
 * and attaches the workspace's data directory path to res.locals.dataDir.
 *
 * Mount on routes that include :wsId in the path.
 */

import type { Request, Response, NextFunction } from "express";
import { getWorkspace } from "../services/workspaceStore.js";
import { warn, info } from "../services/logger.js";

export function resolveWorkspace(req: Request, res: Response, next: NextFunction): void {
  const wsId = String(req.params.wsId);
  if (!wsId) {
    warn(`Workspace resolution failed: requestId=${res.locals.requestId ?? "-"}, reason=missing-workspace-id`);
    res.status(400).json({ error: "Workspace ID is required" });
    return;
  }

  const workspace = getWorkspace(wsId);
  if (!workspace) {
    warn(
      `Workspace resolution failed: requestId=${res.locals.requestId ?? "-"}, workspaceId=${wsId}, reason=not-found`
    );
    res.status(404).json({ error: "Workspace not found" });
    return;
  }

  res.locals.dataDir = workspace.dataDirectory;
  res.locals.workspaceId = workspace.id;
  res.locals.workspaceName = workspace.name;
  info(
    `Workspace resolved: requestId=${res.locals.requestId ?? "-"}, workspaceId=${workspace.id}, workspaceName="${workspace.name}"`
  );
  next();
}
