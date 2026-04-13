import { Router } from "express";
import { getAiConfigs, saveAiConfigs } from "../services/configStore.js";

export const aiConfigsRouter = Router({ mergeParams: true });

aiConfigsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  res.json(getAiConfigs(dataDir));
});

aiConfigsRouter.put("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  saveAiConfigs(dataDir, req.body);
  res.json(getAiConfigs(dataDir));
});
