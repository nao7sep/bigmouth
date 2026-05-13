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
import { parseJsonCandidates } from "../ai/jsonResponse.js";
import { error as logError, info as logInfo, logBlock } from "../services/logger.js";
import { describeAiError, logAiFailure } from "../ai/errorDetails.js";

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

function parseTagJsonResponse(field: string, value: string): string[] {
  for (const parsed of parseJsonCandidates(value)) {
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
    const details = describeAiError(err);
    logError(
      `Generation provider init failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, field=${field}, ${details}`
    );
    res.status(503).json({ error: err instanceof Error ? err.message : "AI provider error" });
    return;
  }

  logInfo(
    `Generation started: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, field=${field}, expectsJson=${expectsJson}, systemLength=${request.systemPrompt.length}, userLength=${request.userContent.length}`
  );

  try {
    const raw = await provider.generateText(request.systemPrompt, request.userContent);
    let value: string;
    try {
      value = normalizeGeneratedValue(field, raw, expectsJson);
    } catch (err) {
      if (expectsJson && (field === "tags" || field === "tagsEn")) {
        logBlock(
          "ERROR",
          `Tag JSON parse failure: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, field=${field}, rawLength=${raw.length}`,
          raw
        );
      }
      throw err;
    }
    logInfo(
      `Generation completed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, field=${field}, expectsJson=${expectsJson}, rawLength=${raw.length}, valueLength=${value.length}`
    );
    res.json({ value });
  } catch (err) {
    const details = logAiFailure(
      {
        kind: "Generation",
        requestId: res.locals.requestId,
        workspaceId: res.locals.workspaceId,
        postId,
        field,
        extra: { expectsJson },
      },
      err
    );
    res.status(502).json({ error: err instanceof Error ? err.message : details });
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
    const details = describeAiError(err);
    logError(
      `Batch generation provider init failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, ${details}`
    );
    res.status(503).json({ error: err instanceof Error ? err.message : "AI provider error" });
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
      logInfo(
        `Batch generation started: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, field=${field}, expectsJson=${expectsJson}, systemLength=${request.systemPrompt.length}, userLength=${request.userContent.length}`
      );
      try {
        const raw = await provider.generateText(request.systemPrompt, request.userContent);
        let value: string;
        try {
          value = normalizeGeneratedValue(field, raw, expectsJson);
        } catch (err) {
          if (expectsJson && (field === "tags" || field === "tagsEn")) {
            logBlock(
              "ERROR",
              `Batch tag JSON parse failure: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, field=${field}, rawLength=${raw.length}`,
              raw
            );
          }
          throw err;
        }
        logInfo(
          `Batch generation completed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, field=${field}, expectsJson=${expectsJson}, rawLength=${raw.length}, valueLength=${value.length}`
        );
        return { field, value };
      } catch (err) {
        const details = logAiFailure(
          {
            kind: "Batch generation",
            requestId: res.locals.requestId,
            workspaceId: res.locals.workspaceId,
            postId,
            field,
            extra: { expectsJson },
          },
          err
        );
        return { field, error: err instanceof Error ? err.message : details };
      }
    })
  );

  const resultMap: Record<string, { value: string } | { error: string }> = {};
  for (const r of results) {
    resultMap[r.field] = "value" in r ? { value: r.value } : { error: r.error };
  }

  res.json({ results: resultMap });
});
