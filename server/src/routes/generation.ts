/**
 * POST /api/w/:wsId/generate
 * Generates one metadata field value for a post using structured AI output.
 *
 * POST /api/w/:wsId/generate/batch
 * Generates multiple metadata fields in one structured AI call.
 */

import { Router } from "express";
import type { Response } from "express";
import { getPost } from "../services/postStore.js";
import { getGenerationPrompts, getAiConfigsForServer } from "../services/configStore.js";
import { createProvider } from "../ai/factory.js";
import {
  buildMetadataGenerationRequest,
  isMetadataField,
  metadataValueToClientString,
  normalizeGeneratedMetadata,
  normalizeMetadataFields,
  type MetadataField,
} from "../ai/metadataGeneration.js";
import { error as logError, info as logInfo } from "../services/logger.js";
import { describeAiError, logAiFailure } from "../ai/errorDetails.js";
import type { AiProvider } from "../ai/provider.js";
import type { Post } from "../shared/types.js";

export const generationRouter = Router({ mergeParams: true });

const METADATA_GENERATION_TIMEOUT_MS = 45_000;
const METADATA_GENERATION_MAX_RETRIES = 1;

type GenerationContext = {
  post: Post;
  postContent: string;
  customPrompts: Record<string, string>;
  provider: AiProvider;
};

type BatchResultMap = Record<string, { value: string } | { error: string }>;

function getGenerationContext(
  res: Response,
  postId: string,
  content: string | undefined
): GenerationContext | null {
  const dataDir = res.locals.dataDir as string;
  const post = getPost(dataDir, postId);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return null;
  }

  try {
    const aiConfigs = getAiConfigsForServer(dataDir);
    const activeConfig = aiConfigs.configs.find(
      (config) => config.id === aiConfigs.activeId
    );
    if (!activeConfig) {
      res.status(503).json({ error: "No active AI configuration selected" });
      return null;
    }

    return {
      post,
      postContent: content?.trim() ? content : post.content,
      customPrompts: getGenerationPrompts(dataDir).prompts,
      provider: createProvider(activeConfig),
    };
  } catch (err) {
    const details = describeAiError(err);
    logError(
      `Generation provider init failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, ${details}`
    );
    res.status(503).json({ error: err instanceof Error ? err.message : "AI provider error" });
    return null;
  }
}

async function generateMetadataFields(
  context: GenerationContext,
  fields: MetadataField[]
): Promise<Record<MetadataField, string>> {
  const request = buildMetadataGenerationRequest({
    fields,
    content: context.postContent,
    frontMatter: context.post.frontMatter,
    customPrompts: context.customPrompts,
  });

  const raw = await context.provider.generateJson(
    request.systemPrompt,
    request.userContent,
    request.schema,
    {
      timeoutMs: METADATA_GENERATION_TIMEOUT_MS,
      maxRetries: METADATA_GENERATION_MAX_RETRIES,
    }
  );
  const generated = normalizeGeneratedMetadata(raw, fields);
  const values = {} as Record<MetadataField, string>;

  for (const field of fields) {
    const value = generated[field];
    if (value === undefined) {
      throw new Error(`Structured metadata response omitted ${field}`);
    }
    values[field] = metadataValueToClientString(value);
  }

  return values;
}

generationRouter.post("/", async (req, res) => {
  const { postId, field, content } = req.body as {
    postId?: string;
    field?: string;
    content?: string;
  };

  if (!postId || !field) {
    res.status(400).json({ error: "postId and field are required" });
    return;
  }
  if (!isMetadataField(field)) {
    res.status(400).json({ error: `Field is not generatable: ${field}` });
    return;
  }

  const context = getGenerationContext(res, postId, content);
  if (!context) return;

  logInfo(
    `Generation started: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, field=${field}, mode=structured, contentLength=${context.postContent.length}`
  );

  try {
    const values = await generateMetadataFields(context, [field]);
    const value = values[field];
    logInfo(
      `Generation completed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, field=${field}, mode=structured, valueLength=${value.length}`
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
        extra: {
          mode: "structured",
          timeoutMs: METADATA_GENERATION_TIMEOUT_MS,
          maxRetries: METADATA_GENERATION_MAX_RETRIES,
        },
      },
      err
    );
    res.status(502).json({ error: err instanceof Error ? err.message : details });
  }
});

generationRouter.post("/batch", async (req, res) => {
  const { postId, fields, content } = req.body as {
    postId?: string;
    fields?: string[];
    content?: string;
  };

  if (!postId || !Array.isArray(fields) || fields.length === 0) {
    res.status(400).json({ error: "postId and fields[] are required" });
    return;
  }

  const results: BatchResultMap = {};
  for (const field of fields) {
    if (!isMetadataField(field)) {
      results[field] = { error: `Field is not generatable: ${field}` };
    }
  }

  const validFields = normalizeMetadataFields(fields);
  if (validFields.length === 0) {
    res.json({ results });
    return;
  }

  const context = getGenerationContext(res, postId, content);
  if (!context) return;

  logInfo(
    `Batch generation started: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, fields=${validFields.join(",")}, mode=structured, contentLength=${context.postContent.length}`
  );

  try {
    const values = await generateMetadataFields(context, validFields);
    for (const field of validFields) {
      results[field] = { value: values[field] };
    }
    logInfo(
      `Batch generation completed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, fields=${validFields.join(",")}, mode=structured`
    );
  } catch (err) {
    const details = logAiFailure(
      {
        kind: "Batch generation",
        requestId: res.locals.requestId,
        workspaceId: res.locals.workspaceId,
        postId,
        extra: {
          fields: validFields,
          mode: "structured",
          timeoutMs: METADATA_GENERATION_TIMEOUT_MS,
          maxRetries: METADATA_GENERATION_MAX_RETRIES,
        },
      },
      err
    );
    const message = err instanceof Error ? err.message : details;
    for (const field of validFields) {
      results[field] = { error: message };
    }
  }

  res.json({ results });
});
