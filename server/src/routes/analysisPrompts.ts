import { Router } from "express";
import { getAnalysisPrompts, saveAnalysisPrompts } from "../services/configStore.js";
import type { AnalysisPrompt } from "../shared/types.js";
import { DEFAULT_ANALYSIS_PROMPTS } from "../shared/defaults.js";

export const analysisPromptsRouter = Router({ mergeParams: true });

analysisPromptsRouter.get("/defaults", (_req, res) => {
  res.json(DEFAULT_ANALYSIS_PROMPTS);
});

analysisPromptsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  res.json(getAnalysisPrompts(dataDir));
});

analysisPromptsRouter.put("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const prompts = req.body as AnalysisPrompt[];
  saveAnalysisPrompts(dataDir, prompts);
  res.json(getAnalysisPrompts(dataDir));
});
