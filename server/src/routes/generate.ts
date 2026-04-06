/**
 * POST /api/generate
 * Generates a metadata field value for a post using the configured AI provider.
 *
 * Body: { postId: string, field: string }
 * Response: { value: string }
 *
 * POST /api/generate/batch
 * Generates multiple metadata fields in parallel.
 *
 * Body: { postId: string, fields: string[] }
 * Response: { results: Record<string, { value: string } | { error: string }> }
 */

import { Router } from "express";
import { getPost } from "../services/postStore.js";
import { getSettings } from "../services/configStore.js";
import { createProvider } from "../ai/factory.js";
import { systemPromptForField } from "../ai/generatePrompts.js";
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

  const systemPrompt = systemPromptForField(field);
  if (!systemPrompt) {
    res.status(400).json({ error: `Field is not generatable: ${field}` });
    return;
  }

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
    const raw = await provider.generateText(systemPrompt, post.content);
    const value = raw.trim().replace(/^["']|["']$/g, "");
    res.json({ value });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    logError(`Generate failed for post ${postId} field ${field}: ${msg}`);
    res.status(502).json({ error: msg });
  }
});

generateRouter.post("/batch", async (req, res) => {
  const { postId, fields } = req.body as {
    postId?: string;
    fields?: string[];
  };

  if (!postId || !Array.isArray(fields) || fields.length === 0) {
    res.status(400).json({ error: "postId and fields[] are required" });
    return;
  }

  const post = getPost(postId);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

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

  const results = await Promise.all(
    fields.map(async (field): Promise<{ field: string; value: string } | { field: string; error: string }> => {
      const systemPrompt = systemPromptForField(field);
      if (!systemPrompt) {
        return { field, error: `Field is not generatable: ${field}` };
      }
      try {
        const raw = await provider.generateText(systemPrompt, post.content);
        const value = raw.trim().replace(/^["']|["']$/g, "");
        return { field, value };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "AI request failed";
        logError(`Generate failed for post ${postId} field ${field}: ${msg}`);
        return { field, error: msg };
      }
    })
  );

  const resultMap: Record<string, { value: string } | { error: string }> = {};
  for (const r of results) {
    resultMap[r.field] = "value" in r ? { value: r.value } : { error: r.error };
  }

  res.json({ results: resultMap });
});
