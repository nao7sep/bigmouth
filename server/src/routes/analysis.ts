/**
 * POST /api/w/:wsId/analyze
 * Runs a named prompt against the post content using the configured AI provider.
 */

import { Router } from "express";
import { getPost } from "../services/postStore.js";
import { getAnalysisPrompts, getAiConfigsForServer } from "../services/configStore.js";
import { createProvider } from "../ai/factory.js";
import { resolvePromptRequest } from "../ai/promptTemplates.js";
import { error as logError } from "../services/logger.js";

export const analysisRouter = Router({ mergeParams: true });

analysisRouter.post("/", async (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const { postId, promptName, content } = req.body as {
    postId?: string;
    promptName?: string;
    content?: string;
  };

  if (!postId || !promptName) {
    res.status(400).json({ error: "postId and promptName are required" });
    return;
  }

  const post = getPost(dataDir, postId);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  const prompts = getAnalysisPrompts(dataDir);
  const prompt = prompts.find((p) => p.name === promptName);
  if (!prompt) {
    res.status(404).json({ error: `Analysis prompt not found: ${promptName}` });
    return;
  }

  const postContent = (content?.trim()) ? content : post.content;
  const { systemPrompt, userContent } = resolvePromptRequest(prompt.text, {
    content: postContent,
  });

  let provider;
  try {
    const aiConfigs = getAiConfigsForServer(dataDir);
    const activeConfig = aiConfigs.configs.find(
      (c) => c.id === aiConfigs.activeId
    );
    if (!activeConfig) {
      res.status(503).json({ error: "No active AI configuration selected" });
      return;
    }
    provider = createProvider(activeConfig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI provider error";
    logError(`AI provider init failed for post ${postId}: ${msg}`);
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
