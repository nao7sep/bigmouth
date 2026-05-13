import { Router } from "express";
import { getGenerationPrompts, saveGenerationPrompts } from "../services/configStore.js";
import { DEFAULT_GENERATION_PROMPTS_DATA } from "../shared/defaults.js";

export const generationPromptsRouter = Router({ mergeParams: true });

generationPromptsRouter.get("/defaults", (_req, res) => {
  res.json(DEFAULT_GENERATION_PROMPTS_DATA);
});

generationPromptsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  res.json(getGenerationPrompts(dataDir));
});

generationPromptsRouter.put("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  saveGenerationPrompts(dataDir, req.body);
  res.json(getGenerationPrompts(dataDir));
});
