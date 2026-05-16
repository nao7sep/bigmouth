import { Router } from "express";
import { getTargets, saveTargets } from "../services/configStore.js";
import { renameTarget } from "../services/postStore.js";
import * as logger from "../services/logger.js";

export const targetsRouter = Router({ mergeParams: true });

targetsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  const targets = getTargets(dataDir);
  logger.info(
    `Targets loaded: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, count=${targets.length}`
  );
  res.json(targets);
});

targetsRouter.put("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  saveTargets(dataDir, req.body);
  const targets = getTargets(dataDir);
  logger.info(
    `Targets saved: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, count=${targets.length}`
  );
  res.json(targets);
});

targetsRouter.put("/rename", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const { oldName, newName } = req.body;

  if (
    typeof oldName !== "string" ||
    typeof newName !== "string" ||
    !oldName.trim() ||
    !newName.trim()
  ) {
    res.status(400).json({ error: "oldName and newName are required" });
    return;
  }

  const normalizedOldName = oldName.trim();
  const normalizedNewName = newName.trim();

  const targets = getTargets(dataDir);
  const target = targets.find((t) => t.name === normalizedOldName);
  if (!target) {
    res.status(404).json({ error: "Target not found" });
    return;
  }
  if (targets.some((t) => t.name === normalizedNewName && t.name !== normalizedOldName)) {
    res.status(400).json({ error: "A target with that name already exists" });
    return;
  }

  target.name = normalizedNewName;
  saveTargets(dataDir, targets);

  const postsUpdated = renameTarget(dataDir, normalizedOldName, normalizedNewName);

  logger.info(
    `Target renamed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, "${normalizedOldName}" → "${normalizedNewName}", postsUpdated=${postsUpdated}`
  );

  res.json({ targets: getTargets(dataDir), postsUpdated });
});
