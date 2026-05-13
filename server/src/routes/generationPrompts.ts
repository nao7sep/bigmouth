import { Router } from "express";
import { getGenerationPrompts, saveGenerationPrompts } from "../services/configStore.js";
import { DEFAULT_GENERATION_PROMPTS_DATA } from "../shared/defaults.js";
import * as logger from "../services/logger.js";

export const generationPromptsRouter = Router({ mergeParams: true });

generationPromptsRouter.get("/defaults", (_req, res) => {
  logger.info(
    `Generation prompt defaults loaded: requestId=${res.locals.requestId ?? "-"}, count=${Object.keys(DEFAULT_GENERATION_PROMPTS_DATA.prompts).length}`
  );
  res.json(DEFAULT_GENERATION_PROMPTS_DATA);
});

generationPromptsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  const prompts = getGenerationPrompts(dataDir);
  logger.info(
    `Generation prompts loaded: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, count=${Object.keys(prompts.prompts).length}`
  );
  res.json(prompts);
});

generationPromptsRouter.put("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  saveGenerationPrompts(dataDir, req.body);
  const prompts = getGenerationPrompts(dataDir);
  logger.info(
    `Generation prompts saved: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, count=${Object.keys(prompts.prompts).length}`
  );
  res.json(prompts);
});
