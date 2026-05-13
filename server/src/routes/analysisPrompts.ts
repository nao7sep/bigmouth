import { Router } from "express";
import { getAnalysisPrompts, saveAnalysisPrompts } from "../services/configStore.js";
import type { AnalysisPrompt } from "../shared/types.js";
import { DEFAULT_ANALYSIS_PROMPTS } from "../shared/defaults.js";
import * as logger from "../services/logger.js";

export const analysisPromptsRouter = Router({ mergeParams: true });

analysisPromptsRouter.get("/defaults", (_req, res) => {
  logger.info(
    `Analysis prompt defaults loaded: requestId=${res.locals.requestId ?? "-"}, count=${DEFAULT_ANALYSIS_PROMPTS.length}`
  );
  res.json(DEFAULT_ANALYSIS_PROMPTS);
});

analysisPromptsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  const prompts = getAnalysisPrompts(dataDir);
  logger.info(
    `Analysis prompts loaded: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, count=${prompts.length}`
  );
  res.json(prompts);
});

analysisPromptsRouter.put("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const prompts = req.body as AnalysisPrompt[];
  saveAnalysisPrompts(dataDir, prompts);
  const saved = getAnalysisPrompts(dataDir);
  logger.info(
    `Analysis prompts saved: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, count=${saved.length}`
  );
  res.json(saved);
});
