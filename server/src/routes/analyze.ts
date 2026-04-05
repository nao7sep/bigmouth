/**
 * POST /api/analyze
 * Runs a named prompt against the post content using the configured AI provider.
 *
 * Body: { postId: string, promptName: string }
 * Response: { result: string }
 */

import { Router } from "express";
import { getPost } from "../services/postStore.js";
import { getSettings, getPrompts } from "../services/configStore.js";
import { createProvider } from "../ai/factory.js";
import { error as logError } from "../services/logger.js";

export const analyzeRouter = Router();

analyzeRouter.post("/", async (req, res) => {
  const { postId, promptName } = req.body as {
    postId?: string;
    promptName?: string;
  };

  if (!postId || !promptName) {
    res.status(400).json({ error: "postId and promptName are required" });
    return;
  }

  // Load the post
  const post = getPost(postId);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  // Find the prompt
  const prompts = getPrompts();
  const prompt = prompts.find((p) => p.name === promptName);
  if (!prompt) {
    res.status(404).json({ error: `Prompt not found: ${promptName}` });
    return;
  }

  // Substitute {content} placeholder
  const renderedPrompt = prompt.text.replace("{content}", post.content);

  // Create the AI provider from current settings
  let provider;
  try {
    const settings = getSettings();
    provider = createProvider(settings.ai);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI provider error";
    res.status(503).json({ error: msg });
    return;
  }

  // Run the analysis
  try {
    const result = await provider.analyze(renderedPrompt);
    res.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    logError(`AI analysis failed for post ${postId}: ${msg}`);
    res.status(502).json({ error: msg });
  }
});
