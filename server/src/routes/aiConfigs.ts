import { Router } from "express";
import { getAiConfigsForClient, saveAiConfigs } from "../services/configStore.js";
import * as logger from "../services/logger.js";

export const aiConfigsRouter = Router({ mergeParams: true });

aiConfigsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  const configs = getAiConfigsForClient(dataDir);
  logger.info(
    `AI configs loaded: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, configCount=${configs.configs.length}, activeId=${configs.activeId}`
  );
  res.json(configs);
});

aiConfigsRouter.put("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  saveAiConfigs(dataDir, req.body);
  const configs = getAiConfigsForClient(dataDir);
  logger.info(
    `AI configs saved: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, configCount=${configs.configs.length}, activeId=${configs.activeId}`
  );
  res.json(configs);
});
