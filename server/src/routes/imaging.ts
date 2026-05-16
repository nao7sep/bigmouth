import { Router } from "express";
import { getPost } from "../services/postStore.js";
import { getAiConfigsForServer } from "../services/configStore.js";
import { createProvider } from "../ai/factory.js";
import { error as logError, info as logInfo } from "../services/logger.js";
import {
  buildImagingSchema,
  buildImagingSystemPrompt,
  buildImagingUserContent,
  IMAGING_COUNTS,
  IMAGING_MOODS,
  IMAGING_LITERALNESS,
  IMAGING_PEOPLE,
  IMAGING_RELATIONS,
  IMAGING_STYLES,
  normalizeImagingOutput,
  type ImagingOptions,
} from "../ai/imaging.js";
import { describeAiError, logAiFailure } from "../ai/errorDetails.js";

export const imagingRouter = Router({ mergeParams: true });

const IMAGING_GENERATION_TIMEOUT_MS = 60_000;
const IMAGING_GENERATION_MAX_RETRIES = 1;
const IMAGING_GENERATION_MAX_TOKENS = 4096;

imagingRouter.post("/", async (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const {
    postId,
    content,
    count,
    relation,
    emotionalLens,
    literalness,
    people,
    style,
  } = req.body as {
    postId?: string;
    content?: string;
    count?: number;
    relation?: string;
    emotionalLens?: string;
    literalness?: string;
    people?: string;
    style?: string;
  };

  if (!postId) {
    res.status(400).json({ error: "postId is required" });
    return;
  }

  const post = getPost(dataDir, postId);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  const options: ImagingOptions = {
    count:
      typeof count === "number" && IMAGING_COUNTS.includes(count as (typeof IMAGING_COUNTS)[number])
        ? count
        : 5,
    relation:
      typeof relation === "string" &&
      IMAGING_RELATIONS.includes(relation as (typeof IMAGING_RELATIONS)[number])
        ? (relation as ImagingOptions["relation"])
        : "domain",
    emotionalLens:
      typeof emotionalLens === "string" &&
      IMAGING_MOODS.includes(emotionalLens as (typeof IMAGING_MOODS)[number])
        ? (emotionalLens as ImagingOptions["emotionalLens"])
        : "hopeful",
    literalness:
      typeof literalness === "string" &&
      IMAGING_LITERALNESS.includes(literalness as (typeof IMAGING_LITERALNESS)[number])
        ? (literalness as ImagingOptions["literalness"])
        : "stylized",
    people:
      typeof people === "string" &&
      IMAGING_PEOPLE.includes(people as (typeof IMAGING_PEOPLE)[number])
        ? (people as ImagingOptions["people"])
        : "mixed",
    style:
      typeof style === "string" &&
      IMAGING_STYLES.includes(style as (typeof IMAGING_STYLES)[number])
        ? (style as ImagingOptions["style"])
        : "illustration",
  };

  const postContent = content?.trim() ? content : post.content;
  const systemPrompt = buildImagingSystemPrompt(options.count);
  const userContent = buildImagingUserContent(postContent, options, {
    targetName: post.frontMatter.target,
    frontMatter: post.frontMatter,
  });

  let provider;
  try {
    const aiConfigs = getAiConfigsForServer(dataDir);
    const activeConfig = aiConfigs.configs.find((c) => c.id === aiConfigs.activeId);
    if (!activeConfig) {
      res.status(503).json({ error: "No active AI configuration selected" });
      return;
    }
    provider = createProvider(activeConfig);
  } catch (err) {
    const details = describeAiError(err);
    logError(
      `Imaging provider init failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, ${details}`
    );
    res.status(503).json({ error: err instanceof Error ? err.message : "Request failed" });
    return;
  }

  logInfo(
    `Imaging started: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, options=${JSON.stringify(options)}, mode=structured, systemLength=${systemPrompt.length}, userLength=${userContent.length}`
  );

  try {
    const raw = await provider.generateJson(
      systemPrompt,
      userContent,
      buildImagingSchema(options.count),
      {
        timeoutMs: IMAGING_GENERATION_TIMEOUT_MS,
        maxRetries: IMAGING_GENERATION_MAX_RETRIES,
        maxTokens: IMAGING_GENERATION_MAX_TOKENS,
      }
    );
    const items = normalizeImagingOutput(raw, options.count);
    logInfo(
      `Imaging completed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, itemCount=${items.length}, mode=structured`
    );
    res.json({ items });
  } catch (err) {
    const details = logAiFailure(
      {
        kind: "Imaging",
        requestId: res.locals.requestId,
        workspaceId: res.locals.workspaceId,
        postId,
        extra: {
          ...options,
          mode: "structured",
          timeoutMs: IMAGING_GENERATION_TIMEOUT_MS,
          maxRetries: IMAGING_GENERATION_MAX_RETRIES,
        },
      },
      err
    );
    res.status(502).json({ error: err instanceof Error ? err.message : details });
  }
});
