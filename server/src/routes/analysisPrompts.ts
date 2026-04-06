import { Router } from "express";
import { getAnalysisPrompts, saveAnalysisPrompts } from "../services/configStore.js";
import type { AnalysisPrompt } from "../shared/types.js";

export const analysisPromptsRouter = Router();

/**
 * GET /api/prompts
 *
 * Returns the analysis prompts array.
 */
analysisPromptsRouter.get("/", (_req, res) => {
  res.json(getAnalysisPrompts());
});

/**
 * PUT /api/prompts
 *
 * Replaces the entire analysis prompts array.
 */
analysisPromptsRouter.put("/", (req, res) => {
  const prompts = req.body as AnalysisPrompt[];
  saveAnalysisPrompts(prompts);
  res.json(getAnalysisPrompts());
});
