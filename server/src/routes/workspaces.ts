/**
 * Workspace management routes.
 * Mounted at /api/workspaces (no workspace prefix — manages workspaces themselves).
 */

import { Router } from "express";
import {
  listWorkspaces,
  getWorkspace,
  openOrCreateWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from "../services/workspaceStore.js";
import * as logger from "../services/logger.js";

export const workspacesRouter = Router();

/**
 * GET /api/workspaces
 * Returns all workspaces.
 */
workspacesRouter.get("/", (_req, res) => {
  const workspaces = listWorkspaces();
  logger.info(
    `Workspaces listed: requestId=${res.locals.requestId ?? "-"}, count=${workspaces.length}`
  );
  res.json(workspaces);
});

/**
 * GET /api/workspaces/:id
 * Returns a single workspace.
 */
workspacesRouter.get("/:id", (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) {
    logger.warn(
      `Workspace lookup failed: requestId=${res.locals.requestId ?? "-"}, workspaceId=${req.params.id}, reason=not-found`
    );
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  logger.info(
    `Workspace loaded: requestId=${res.locals.requestId ?? "-"}, workspaceId=${ws.id}, workspaceName="${ws.name}"`
  );
  res.json(ws);
});

/**
 * POST /api/workspaces/open-or-create
 * Opens an existing workspace folder or creates a new one there.
 * Body: { name?: string, dataDirectory?: string }
 */
workspacesRouter.post("/open-or-create", (req, res) => {
  const { name, dataDirectory } = req.body;

  try {
    const ws = openOrCreateWorkspace(name?.trim(), dataDirectory?.trim());
    logger.info(
      `Workspace selected: requestId=${res.locals.requestId ?? "-"}, id=${ws.id}, name="${ws.name}", dir=${ws.dataDirectory}`
    );
    res.status(201).json(ws);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to open or create workspace";
    logger.error(
      `Workspace open-or-create failed: requestId=${res.locals.requestId ?? "-"}, message=${message}`
    );
    res.status(400).json({ error: message });
  }
});

/**
 * PUT /api/workspaces/:id
 * Updates a workspace (name and/or dataDirectory).
 * Body: { name?: string, dataDirectory?: string }
 */
workspacesRouter.put("/:id", (req, res) => {
  const { name, dataDirectory } = req.body;

  try {
    const ws = updateWorkspace(req.params.id, {
      name: name?.trim(),
      dataDirectory: dataDirectory?.trim(),
    });

    if (!ws) {
      logger.warn(
        `Workspace update failed: requestId=${res.locals.requestId ?? "-"}, workspaceId=${req.params.id}, reason=not-found`
      );
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    logger.info(
      `Workspace updated: requestId=${res.locals.requestId ?? "-"}, id=${ws.id}, name="${ws.name}", dir=${ws.dataDirectory}`
    );
    res.json(ws);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update workspace";
    logger.error(
      `Workspace update failed: requestId=${res.locals.requestId ?? "-"}, workspaceId=${req.params.id}, message=${message}`
    );
    res.status(400).json({ error: message });
  }
});

/**
 * DELETE /api/workspaces/:id
 * Removes a workspace from the registry. Data files on disk are not deleted.
 */
workspacesRouter.delete("/:id", (req, res) => {
  const deleted = deleteWorkspace(req.params.id);
  if (!deleted) {
    logger.warn(
      `Workspace delete failed: requestId=${res.locals.requestId ?? "-"}, workspaceId=${req.params.id}, reason=not-found`
    );
    res.status(404).json({ error: "Workspace not found" });
    return;
  }

  logger.info(
    `Workspace removed from registry: requestId=${res.locals.requestId ?? "-"}, id=${req.params.id}`
  );
  res.json({ deleted: true });
});
