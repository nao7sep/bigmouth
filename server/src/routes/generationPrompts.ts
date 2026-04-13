import { Router } from "express";
import { getGenerationPrompts, saveGenerationPrompts } from "../services/configStore.js";

export const generationPromptsRouter = Router({ mergeParams: true });

generationPromptsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  res.json(getGenerationPrompts(dataDir));
});

generationPromptsRouter.put("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  saveGenerationPrompts(dataDir, req.body);
  res.json(getGenerationPrompts(dataDir));
});
