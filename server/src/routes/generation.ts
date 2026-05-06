/**
 * POST /api/w/:wsId/generate
 * Generates a metadata field value for a post using the configured AI provider.
 *
 * POST /api/w/:wsId/generate/batch
 * Generates multiple metadata fields in parallel.
 */

import { Router } from "express";
import { getPost } from "../services/postStore.js";
import { getGenerationPrompts, getAiConfigsForServer } from "../services/configStore.js";
import { createProvider } from "../ai/factory.js";
import { systemPromptForField } from "../ai/generationPrompts.js";
import { error as logError } from "../services/logger.js";

export const generationRouter = Router({ mergeParams: true });

generationRouter.post("/", async (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const { postId, field, content } = req.body as {
    postId?: string;
    field?: string;
    content?: string;
  };

  if (!postId || !field) {
    res.status(400).json({ error: "postId and field are required" });
    return;
  }

  const post = getPost(dataDir, postId);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  const postContent = (content?.trim()) ? content : post.content;

  let provider;
  let systemPrompt: string;
  try {
    const genPrompts = getGenerationPrompts(dataDir);
    const resolved = systemPromptForField(field, genPrompts.preamble, genPrompts.prompts);
    if (!resolved) {
      res.status(400).json({ error: `Field is not generatable: ${field}` });
      return;
    }
    systemPrompt = resolved;
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
    const raw = await provider.generateText(systemPrompt, postContent);
    const value = raw.trim().replace(/^["']|["']$/g, "");
    res.json({ value });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    logError(`Generate failed for post ${postId} field ${field}: ${msg}`);
    res.status(502).json({ error: msg });
  }
});

generationRouter.post("/batch", async (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const { postId, fields, content } = req.body as {
    postId?: string;
    fields?: string[];
    content?: string;
  };

  if (!postId || !Array.isArray(fields) || fields.length === 0) {
    res.status(400).json({ error: "postId and fields[] are required" });
    return;
  }

  const post = getPost(dataDir, postId);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  const postContent = (content?.trim()) ? content : post.content;

  let provider;
  let customPrompts: Record<string, string>;
  let preamble: string;
  try {
    const genPrompts = getGenerationPrompts(dataDir);
    customPrompts = genPrompts.prompts;
    preamble = genPrompts.preamble;
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
    logError(`AI provider init failed for batch generate, post ${postId}: ${msg}`);
    res.status(503).json({ error: msg });
    return;
  }

  const results = await Promise.all(
    fields.map(async (field): Promise<{ field: string; value: string } | { field: string; error: string }> => {
      const systemPrompt = systemPromptForField(field, preamble, customPrompts);
      if (!systemPrompt) {
        return { field, error: `Field is not generatable: ${field}` };
      }
      try {
        const raw = await provider.generateText(systemPrompt, postContent);
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
