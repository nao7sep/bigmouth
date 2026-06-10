import { Router } from "express";
import { getSettings, saveSettings } from "../services/configStore.js";
import type { Settings } from "../shared/types.js";
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
  const body = req.body as Partial<Record<keyof Settings, unknown>>;

  if (typeof body.timezone !== "string" || !body.timezone.trim()) {
    res.status(400).json({ error: "timezone must be a non-empty string" });
    return;
  }
  if (
    !Array.isArray(body.supportedLanguages) ||
    !body.supportedLanguages.every((l) => typeof l === "string")
  ) {
    res.status(400).json({ error: "supportedLanguages must be an array of strings" });
    return;
  }
  if (
    typeof body.publishedPostsPerLoad !== "number" ||
    !Number.isInteger(body.publishedPostsPerLoad) ||
    body.publishedPostsPerLoad < 1
  ) {
    res.status(400).json({ error: "publishedPostsPerLoad must be a positive integer" });
    return;
  }
  if (typeof body.maxUploadMb !== "number" || !(body.maxUploadMb > 0)) {
    res.status(400).json({ error: "maxUploadMb must be a positive number" });
    return;
  }
  if (typeof body.editorWatermark !== "string") {
    res.status(400).json({ error: "editorWatermark must be a string" });
    return;
  }
  if (typeof body.extraFieldWatermark !== "string") {
    res.status(400).json({ error: "extraFieldWatermark must be a string" });
    return;
  }

  const settings = saveSettings(dataDir, body as Settings);
  logger.info(
    `Settings saved: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, timezone=${settings.timezone}, supportedLanguages=${settings.supportedLanguages.length}`
  );
  res.json(settings);
});
