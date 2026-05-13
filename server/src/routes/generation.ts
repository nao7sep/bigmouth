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
import {
  resolvePromptRequest,
  usesJsonPlaceholder,
} from "../ai/promptTemplates.js";
import { error as logError } from "../services/logger.js";

export const generationRouter = Router({ mergeParams: true });

function tagJsonFormatForField(field: string): string {
  return `{
  "${field}": [
    "tag1",
    "tag2",
    "tag3"
  ]
}`;
}

function normalizeTagList(tags: unknown): string[] | null {
  if (!Array.isArray(tags)) return null;
  const normalized = tags
    .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
    .filter(Boolean);
  return normalized.length >= 2 ? normalized : null;
}

function extractBracketedJson(text: string, openChar: "[" | "{", closeChar: "]" | "}"): string | null {
  const start = text.indexOf(openChar);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === openChar) {
      depth += 1;
      continue;
    }
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseTagJsonResponse(field: string, value: string): string[] {
  const candidates = new Set<string>();
  const trimmed = value.trim();
  candidates.add(trimmed);

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
    const inner = match[1]?.trim();
    if (inner) candidates.add(inner);
  }

  const arraySnippet = extractBracketedJson(trimmed, "[", "]");
  if (arraySnippet) candidates.add(arraySnippet);

  const objectSnippet = extractBracketedJson(trimmed, "{", "}");
  if (objectSnippet) candidates.add(objectSnippet);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    const direct = normalizeTagList(parsed);
    if (direct) return direct;

    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of [field, "tags", "tagsEn", "value", "items"]) {
        const extracted = normalizeTagList(record[key]);
        if (extracted) return extracted;
      }
    }
  }

  throw new Error("Generated tags were not valid JSON");
}

function normalizeGeneratedValue(field: string, raw: string, expectsJson = false): string {
  const value = raw.trim().replace(/^["']|["']$/g, "");

  if (field === "tags" || field === "tagsEn") {
    if (expectsJson) {
      return parseTagJsonResponse(field, value).join(", ");
    }

    if (value.includes("\n") || value.includes("\r")) {
      throw new Error("Generated tags were not a single comma-separated list");
    }
    const tags = value
      .split(/[,\u3001]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (tags.length < 2) {
      throw new Error("Generated tags were not a valid comma-separated list");
    }
  }

  return value;
}

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
  let request: { systemPrompt: string; userContent: string };
  let expectsJson = false;
  try {
    const genPrompts = getGenerationPrompts(dataDir);
    const resolved = systemPromptForField(field, genPrompts.prompts);
    if (!resolved) {
      res.status(400).json({ error: `Field is not generatable: ${field}` });
      return;
    }
    expectsJson = (field === "tags" || field === "tagsEn") && usesJsonPlaceholder(resolved);
    if ((field !== "tags" && field !== "tagsEn") && usesJsonPlaceholder(resolved)) {
      res.status(400).json({ error: "{json} is only supported for tags and tagsEn" });
      return;
    }
    request = resolvePromptRequest(resolved, {
      content: postContent,
      json: expectsJson ? tagJsonFormatForField(field) : undefined,
    });
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
    const raw = await provider.generateText(request.systemPrompt, request.userContent);
    const value = normalizeGeneratedValue(field, raw, expectsJson);
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
  try {
    const genPrompts = getGenerationPrompts(dataDir);
    customPrompts = genPrompts.prompts;
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
      const promptTemplate = systemPromptForField(field, customPrompts);
      if (!promptTemplate) {
        return { field, error: `Field is not generatable: ${field}` };
      }
      const expectsJson =
        (field === "tags" || field === "tagsEn") && usesJsonPlaceholder(promptTemplate);
      if ((field !== "tags" && field !== "tagsEn") && usesJsonPlaceholder(promptTemplate)) {
        return { field, error: "{json} is only supported for tags and tagsEn" };
      }
      const request = resolvePromptRequest(promptTemplate, {
        content: postContent,
        json: expectsJson ? tagJsonFormatForField(field) : undefined,
      });
      try {
        const raw = await provider.generateText(request.systemPrompt, request.userContent);
        const value = normalizeGeneratedValue(field, raw, expectsJson);
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
