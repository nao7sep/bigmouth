/**
 * Workspace management routes.
 * Mounted at /api/workspaces (no workspace prefix — manages workspaces themselves).
 */

import { Router } from "express";
import {
  listWorkspaces,
  getWorkspace,
  createWorkspace,
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
  res.json(listWorkspaces());
});

/**
 * GET /api/workspaces/:id
 * Returns a single workspace.
 */
workspacesRouter.get("/:id", (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  res.json(ws);
});

/**
 * POST /api/workspaces
 * Creates a new workspace.
 * Body: { name: string, dataDirectory?: string }
 */
workspacesRouter.post("/", (req, res) => {
  const { name, dataDirectory } = req.body;

  if (!name || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  try {
    const ws = createWorkspace(name.trim(), dataDirectory?.trim() || undefined);
    logger.info(`Workspace created: id=${ws.id}, name="${ws.name}", dir=${ws.dataDirectory}`);
    res.status(201).json(ws);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create workspace";
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
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    logger.info(`Workspace updated: id=${ws.id}, name="${ws.name}"`);
    res.json(ws);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update workspace";
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
    res.status(404).json({ error: "Workspace not found" });
    return;
  }

  logger.info(`Workspace removed from registry: id=${req.params.id}`);
  res.json({ deleted: true });
});
