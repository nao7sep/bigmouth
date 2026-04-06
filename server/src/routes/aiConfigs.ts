import { Router } from "express";
import { getAiConfigs, saveAiConfigs } from "../services/configStore.js";

export const aiConfigsRouter = Router();

aiConfigsRouter.get("/", (_req, res) => {
  res.json(getAiConfigs());
});

aiConfigsRouter.put("/", (req, res) => {
  saveAiConfigs(req.body);
  res.json(getAiConfigs());
});
