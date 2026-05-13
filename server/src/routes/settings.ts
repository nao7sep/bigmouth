import { Router } from "express";
import { getSettings, saveSettings } from "../services/configStore.js";
import * as logger from "../services/logger.js";

export const settingsRouter = Router({ mergeParams: true });

settingsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  const settings = getSettings(dataDir);
  logger.info(
    `Settings loaded: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}`
  );
  res.json(settings);
});

settingsRouter.put("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  saveSettings(dataDir, req.body);
  const settings = getSettings(dataDir);
  logger.info(
    `Settings saved: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, timezone=${settings.timezone}, supportedLanguages=${settings.supportedLanguages.length}`
  );
  res.json(settings);
});
