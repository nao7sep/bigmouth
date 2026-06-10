import { Router } from "express";
import { getAnalysisPrompts, saveAnalysisPrompts } from "../services/configStore.js";
import type { AnalysisPrompt } from "../shared/types.js";
import { DEFAULT_ANALYSIS_PROMPTS } from "../shared/defaults.js";
import * as logger from "../services/logger.js";

export const analysisPromptsRouter = Router({ mergeParams: true });

analysisPromptsRouter.get("/defaults", (_req, res) => {
  logger.info("analysis prompt defaults loaded", {
    requestId: res.locals.requestId ?? null,
    count: DEFAULT_ANALYSIS_PROMPTS.length,
  });
  res.json(DEFAULT_ANALYSIS_PROMPTS);
});

analysisPromptsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  const prompts = getAnalysisPrompts(dataDir);
  logger.info("analysis prompts loaded", {
    requestId: res.locals.requestId ?? null,
    workspace: res.locals.workspaceId ?? null,
    count: prompts.length,
  });
  res.json(prompts);
});

analysisPromptsRouter.put("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const body = req.body;

  if (!Array.isArray(body)) {
    res.status(400).json({ error: "analysis prompts must be an array" });
    return;
  }
  for (const prompt of body) {
    if (!prompt || typeof prompt !== "object") {
      res.status(400).json({ error: "each prompt must be an object" });
      return;
    }
    const p = prompt as Record<string, unknown>;
    if (typeof p.name !== "string" || !p.name.trim()) {
      res.status(400).json({ error: "each prompt needs a non-empty name" });
      return;
    }
    if (typeof p.text !== "string") {
      res.status(400).json({ error: "each prompt needs a text string" });
      return;
    }
  }

  const saved = saveAnalysisPrompts(dataDir, body as AnalysisPrompt[]);
  logger.info("analysis prompts saved", {
    requestId: res.locals.requestId ?? null,
    workspace: res.locals.workspaceId ?? null,
    count: saved.length,
  });
  res.json(saved);
});
