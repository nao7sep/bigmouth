import { Router } from "express";
import { getSettings, saveSettings } from "../services/configStore.js";

export const settingsRouter = Router({ mergeParams: true });

settingsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  res.json(getSettings(dataDir));
});

settingsRouter.put("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  saveSettings(dataDir, req.body);
  res.json(getSettings(dataDir));
});
