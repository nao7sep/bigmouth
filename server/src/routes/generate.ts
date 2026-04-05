/**
 * POST /api/generate
 * Generates a metadata field value for a post using the configured AI provider.
 *
 * Body: { postId: string, field: string }
 * Response: { value: string }
 */

import { Router } from "express";
import { getPost } from "../services/postStore.js";
import { getSettings } from "../services/configStore.js";
import { createProvider } from "../ai/factory.js";
import { promptForField } from "../ai/generatePrompts.js";
import { error as logError } from "../services/logger.js";

export const generateRouter = Router();

generateRouter.post("/", async (req, res) => {
  const { postId, field } = req.body as {
    postId?: string;
    field?: string;
  };

  if (!postId || !field) {
    res.status(400).json({ error: "postId and field are required" });
    return;
  }

  const post = getPost(postId);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  const prompt = promptForField(field, post.content);
  if (!prompt) {
    res.status(400).json({ error: `Field is not generatable: ${field}` });
    return;
  }

  let provider;
  try {
    const settings = getSettings();
    provider = createProvider(settings.ai);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI provider error";
    res.status(503).json({ error: msg });
    return;
  }

  try {
    const raw = await provider.analyze(prompt);
    // Strip surrounding quotes that some models add
    const value = raw.trim().replace(/^["']|["']$/g, "");
    res.json({ value });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    logError(`Generate failed for post ${postId} field ${field}: ${msg}`);
    res.status(502).json({ error: msg });
  }
});
