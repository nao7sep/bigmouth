import { Router } from "express";
import { getTargets, saveTargets } from "../services/configStore.js";
import { renameTarget } from "../services/postStore.js";
import * as logger from "../services/logger.js";

export const targetsRouter = Router();

/**
 * GET /api/targets
 *
 * Returns the targets array.
 */
targetsRouter.get("/", (_req, res) => {
  res.json(getTargets());
});

/**
 * PUT /api/targets
 *
 * Replaces the entire targets array.
 */
targetsRouter.put("/", (req, res) => {
  const targets = req.body;
  saveTargets(targets);
  res.json(getTargets());
});

/**
 * PUT /api/targets/rename
 *
 * Renames a target across targets.json and all post files.
 * Body: { oldName: string, newName: string }
 */
targetsRouter.put("/rename", (req, res) => {
  const { oldName, newName } = req.body;

  if (!oldName || !newName) {
    res.status(400).json({ error: "oldName and newName are required" });
    return;
  }

  // Update targets.json
  const targets = getTargets();
  const target = targets.find((t) => t.name === oldName);
  if (!target) {
    res.status(404).json({ error: "Target not found" });
    return;
  }

  target.name = newName;
  saveTargets(targets);

  // Update all post files
  const postsUpdated = renameTarget(oldName, newName);

  logger.info(
    `Target renamed: "${oldName}" → "${newName}", ${postsUpdated} posts updated`
  );

  res.json({ targets: getTargets(), postsUpdated });
});
