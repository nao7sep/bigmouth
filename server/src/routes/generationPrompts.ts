import { Router } from "express";
import { getGenerationPrompts, saveGenerationPrompts } from "../services/configStore.js";
import { DEFAULT_GENERATION_PROMPTS_DATA } from "../shared/defaults.js";
import type { GenerationPromptsData } from "../shared/types.js";
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
  const body = req.body as { prompts?: unknown };

  if (!body.prompts || typeof body.prompts !== "object" || Array.isArray(body.prompts)) {
    res.status(400).json({ error: "prompts must be an object" });
    return;
  }
  if (!Object.values(body.prompts as Record<string, unknown>).every((v) => typeof v === "string")) {
    res.status(400).json({ error: "every prompt value must be a string" });
    return;
  }

  const prompts = saveGenerationPrompts(dataDir, body as GenerationPromptsData);
  logger.info(
    `Generation prompts saved: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, count=${Object.keys(prompts.prompts).length}`
  );
  res.json(prompts);
});
