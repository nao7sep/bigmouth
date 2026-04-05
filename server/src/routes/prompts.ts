import { Router } from "express";
import { getPrompts, savePrompts } from "../services/configStore.js";

export const promptsRouter = Router();

/**
 * GET /api/prompts
 *
 * Returns the prompts array.
 */
promptsRouter.get("/", (_req, res) => {
  res.json(getPrompts());
});

/**
 * PUT /api/prompts
 *
 * Replaces the entire prompts array.
 */
promptsRouter.put("/", (req, res) => {
  const prompts = req.body;
  savePrompts(prompts);
  res.json(getPrompts());
});
