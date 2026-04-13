import { Router } from "express";
import { getTargets, saveTargets } from "../services/configStore.js";
import { renameTarget } from "../services/postStore.js";
import * as logger from "../services/logger.js";

export const targetsRouter = Router({ mergeParams: true });

targetsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  res.json(getTargets(dataDir));
});

targetsRouter.put("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  saveTargets(dataDir, req.body);
  res.json(getTargets(dataDir));
});

targetsRouter.put("/rename", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const { oldName, newName } = req.body;

  if (!oldName || !newName) {
    res.status(400).json({ error: "oldName and newName are required" });
    return;
  }

  const targets = getTargets(dataDir);
  const target = targets.find((t) => t.name === oldName);
  if (!target) {
    res.status(404).json({ error: "Target not found" });
    return;
  }

  target.name = newName;
  saveTargets(dataDir, targets);

  const postsUpdated = renameTarget(dataDir, oldName, newName);

  logger.info(
    `Target renamed: "${oldName}" → "${newName}", ${postsUpdated} posts updated`
  );

  res.json({ targets: getTargets(dataDir), postsUpdated });
});
