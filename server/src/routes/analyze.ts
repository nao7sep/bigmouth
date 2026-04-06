/**
 * POST /api/analyze
 * Runs a named prompt against the post content using the configured AI provider.
 *
 * The prompt text uses {content} as a placeholder. Everything before {content}
 * becomes the system prompt; the post content becomes the user message. If the
 * prompt contains no {content} marker, the entire prompt text is used as the
 * system prompt.
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

  const post = getPost(postId);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  const prompts = getPrompts();
  const prompt = prompts.find((p) => p.name === promptName);
  if (!prompt) {
    res.status(404).json({ error: `Prompt not found: ${promptName}` });
    return;
  }

  // Split on {content}: text before it is the system prompt, post content is
  // the user message. Fall back to using the full text as system prompt.
  const markerIndex = prompt.text.indexOf("{content}");
  const systemPrompt =
    markerIndex >= 0
      ? prompt.text.slice(0, markerIndex).trim()
      : prompt.text.trim();
  const userContent = post.content;

  let provider;
  try {
    const settings = getSettings();
    const activeConfig = settings.aiConfigs.find(
      (c) => c.id === settings.activeAiConfigId
    );
    if (!activeConfig) {
      res.status(503).json({ error: "No active AI configuration selected" });
      return;
    }
    provider = createProvider(activeConfig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI provider error";
    res.status(503).json({ error: msg });
    return;
  }

  try {
    const result = await provider.generateText(systemPrompt, userContent);
    res.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    logError(`AI analysis failed for post ${postId}: ${msg}`);
    res.status(502).json({ error: msg });
  }
});
