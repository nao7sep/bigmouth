/**
 * POST /api/w/:wsId/analyze
 * Runs a named prompt against the post content using the configured provider.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { getPost } from "../services/postStore.js";
import { getAnalysisPrompts, getAiConfigsForServer } from "../services/configStore.js";
import { createProvider } from "../ai/factory.js";
import { resolvePromptRequest, usesContentPlaceholder } from "../ai/promptTemplates.js";
import { error as logError, formatLogValue, info as logInfo, warn as logWarn } from "../services/logger.js";
import { describeAiError, logAiFailure } from "../ai/errorDetails.js";
import {
  metadataKeys,
  safeAiConfigLogContext,
  safePostLogContext,
} from "../shared/logSummaries.js";
import type { AiProvider } from "../ai/provider.js";
import type { AiConfig, Post } from "../shared/types.js";

export const analysisRouter = Router({ mergeParams: true });

async function resolveAnalysisRequest(
  req: Request,
  res: Response
): Promise<
  | {
      postId: string;
      promptName: string;
      post: Post;
      postContent: string;
      contentSource: "request" | "stored";
      promptMode: "inline-content" | "split-system-user";
      systemPrompt: string;
      userContent: string;
      aiConfig: AiConfig;
      provider: AiProvider;
    }
  | null
> {
  const dataDir = res.locals.dataDir as string;
  const { postId, promptName, content } = req.body as {
    postId?: string;
    promptName?: string;
    content?: string;
  };

  if (!postId || !promptName) {
    res.status(400).json({ error: "postId and promptName are required" });
    return null;
  }

  const post = getPost(dataDir, postId);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return null;
  }

  const prompts = getAnalysisPrompts(dataDir);
  const prompt = prompts.find((p) => p.name === promptName);
  if (!prompt) {
    res.status(404).json({ error: `Analysis prompt not found: ${promptName}` });
    return null;
  }

  const postContent = content?.trim() ? content : post.content;
  const contentSource = content?.trim() ? "request" : "stored";
  const { systemPrompt, userContent } = resolvePromptRequest(prompt.text, {
    content: postContent,
  });
  const promptMode = usesContentPlaceholder(prompt.text)
    ? "inline-content"
    : "split-system-user";

  try {
    const aiConfigs = getAiConfigsForServer(dataDir);
    const activeConfig = aiConfigs.configs.find(
      (c) => c.id === aiConfigs.activeId
    );
    if (!activeConfig) {
      res.status(503).json({ error: "No active AI configuration selected" });
      return null;
    }
    return {
      postId,
      promptName,
      post,
      postContent,
      contentSource,
      promptMode,
      systemPrompt,
      userContent,
      aiConfig: activeConfig,
      provider: createProvider(activeConfig),
    };
  } catch (err) {
    const details = describeAiError(err);
    logError(
      `Analysis provider init failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, ${details}`
    );
    res.status(503).json({ error: err instanceof Error ? err.message : "AI provider error" });
    return null;
  }
}

analysisRouter.post("/", async (req, res) => {
  const request = await resolveAnalysisRequest(req, res);
  if (!request) return;

  logInfo(
    `Analysis started: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${request.postId}, promptName=${request.promptName}, contentSource=${request.contentSource}, contentLength=${request.postContent.length}, promptMode=${request.promptMode}, language=${request.post.frontMatter.language}, target=${request.post.frontMatter.target}, metadataKeys=${metadataKeys(request.post.frontMatter).join(",") || "-"}, ai=${formatLogValue(safeAiConfigLogContext(request.aiConfig))}, post=${formatLogValue(safePostLogContext(request.post))}, systemLength=${request.systemPrompt.length}, userLength=${request.userContent.length}`
  );

  try {
    const result = await request.provider.generateText(
      request.systemPrompt,
      request.userContent
    );
    logInfo(
      `Analysis completed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${request.postId}, resultLength=${result.length}`
    );
    res.json({ result });
  } catch (err) {
    const details = logAiFailure(
      {
        kind: "Analysis",
        requestId: res.locals.requestId,
        workspaceId: res.locals.workspaceId,
        postId: request.postId,
        promptName: request.promptName,
        extra: {
          contentSource: request.contentSource,
          contentLength: request.postContent.length,
          promptMode: request.promptMode,
          language: request.post.frontMatter.language,
          target: request.post.frontMatter.target,
          metadataKeys: metadataKeys(request.post.frontMatter),
          ai: safeAiConfigLogContext(request.aiConfig),
        },
      },
      err
    );
    res.status(502).json({ error: err instanceof Error ? err.message : details });
  }
});

analysisRouter.post("/stream", async (req, res) => {
  const request = await resolveAnalysisRequest(req, res);
  if (!request) return;

  let clientClosed = false;
  let wroteChunk = false;
  logInfo(
    `Analysis stream started: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${request.postId}, promptName=${request.promptName}, contentSource=${request.contentSource}, contentLength=${request.postContent.length}, promptMode=${request.promptMode}, language=${request.post.frontMatter.language}, target=${request.post.frontMatter.target}, metadataKeys=${metadataKeys(request.post.frontMatter).join(",") || "-"}, ai=${formatLogValue(safeAiConfigLogContext(request.aiConfig))}, post=${formatLogValue(safePostLogContext(request.post))}`
  );
  const stream = request.provider.generateTextStream(
    request.systemPrompt,
    request.userContent,
    (delta) => {
      if (clientClosed) return;
      wroteChunk = true;
      if (!res.headersSent) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
      }
      res.write(delta);
    }
  );

  const closeHandler = () => {
    if (res.writableEnded) return;
    clientClosed = true;
    stream.abort();
    logWarn(
      `Analysis stream closed early: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${request.postId}, promptName=${request.promptName}, wroteChunk=${wroteChunk}`
    );
  };
  req.on("close", closeHandler);

  try {
    const finalText = await stream.finished;
    if (clientClosed) return;
    if (!wroteChunk) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.write(finalText);
    }
    logInfo(
      `Analysis stream completed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${request.postId}, wroteChunk=${wroteChunk}, resultLength=${finalText.length}`
    );
    res.end();
  } catch (err) {
    if (clientClosed) return;
    const details = logAiFailure(
      {
        kind: "Analysis stream",
        requestId: res.locals.requestId,
        workspaceId: res.locals.workspaceId,
        postId: request.postId,
        promptName: request.promptName,
        extra: {
          contentSource: request.contentSource,
          contentLength: request.postContent.length,
          promptMode: request.promptMode,
          language: request.post.frontMatter.language,
          target: request.post.frontMatter.target,
          metadataKeys: metadataKeys(request.post.frontMatter),
          ai: safeAiConfigLogContext(request.aiConfig),
          wroteChunk,
        },
      },
      err
    );
    if (!res.headersSent) {
      res.status(502).type("text/plain").send(err instanceof Error ? err.message : details);
      return;
    }
    res.end();
  } finally {
    req.off("close", closeHandler);
  }
});
