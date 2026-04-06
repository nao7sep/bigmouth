import { Router } from "express";
import { getGenerationPrompts, saveGenerationPrompts } from "../services/configStore.js";

export const generationPromptsRouter = Router();

generationPromptsRouter.get("/", (_req, res) => {
  res.json(getGenerationPrompts());
});

generationPromptsRouter.put("/", (req, res) => {
  saveGenerationPrompts(req.body);
  res.json(getGenerationPrompts());
});
