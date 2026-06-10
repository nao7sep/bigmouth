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
  logger.info("workspaces listed", {
    requestId: res.locals.requestId ?? null,
    count: workspaces.length,
  });
  res.json(workspaces);
});

/**
 * GET /api/workspaces/:id
 * Returns a single workspace.
 */
workspacesRouter.get("/:id", (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) {
    logger.warn("workspace lookup failed", {
      requestId: res.locals.requestId ?? null,
      workspaceId: req.params.id,
      reason: "not-found",
    });
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  logger.info("workspace loaded", {
    requestId: res.locals.requestId ?? null,
    workspaceId: ws.id,
    workspaceName: ws.name,
  });
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
    logger.info("workspace selected", {
      requestId: res.locals.requestId ?? null,
      workspaceId: ws.id,
      workspaceName: ws.name,
      dataDirectory: ws.dataDirectory,
    });
    res.status(201).json(ws);
  } catch (err) {
    logger.error("workspace open-or-create failed", {
      requestId: res.locals.requestId ?? null,
      error: logger.serializeError(err),
    });
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed to open or create workspace" });
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
      logger.warn("workspace update failed", {
        requestId: res.locals.requestId ?? null,
        workspaceId: req.params.id,
        reason: "not-found",
      });
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    logger.info("workspace updated", {
      requestId: res.locals.requestId ?? null,
      workspaceId: ws.id,
      workspaceName: ws.name,
      dataDirectory: ws.dataDirectory,
    });
    res.json(ws);
  } catch (err) {
    logger.error("workspace update failed", {
      requestId: res.locals.requestId ?? null,
      workspaceId: req.params.id,
      error: logger.serializeError(err),
    });
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed to update workspace" });
  }
});

/**
 * DELETE /api/workspaces/:id
 * Removes a workspace from the registry. Data files on disk are not deleted.
 */
workspacesRouter.delete("/:id", (req, res) => {
  const deleted = deleteWorkspace(req.params.id);
  if (!deleted) {
    logger.warn("workspace delete failed", {
      requestId: res.locals.requestId ?? null,
      workspaceId: req.params.id,
      reason: "not-found",
    });
    res.status(404).json({ error: "Workspace not found" });
    return;
  }

  logger.info("workspace removed from registry", {
    requestId: res.locals.requestId ?? null,
    workspaceId: req.params.id,
  });
  res.json({ deleted: true });
});
