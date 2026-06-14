/**
 * POST /api/w/:wsId/analyze
 * Runs a named prompt against the post content using the configured provider.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { getPost } from "../services/postStore.js";
import { getAnalysisPrompts, getActiveAiConfig } from "../services/configStore.js";
import { createProvider } from "../ai/factory.js";
import { resolvePromptRequest, usesContentPlaceholder } from "../ai/promptTemplates.js";
import { error as logError, info as logInfo, warn as logWarn } from "../services/logger.js";
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

  const activeConfig = getActiveAiConfig(dataDir);
  if (!activeConfig) {
    res.status(503).json({ error: "No active AI configuration selected" });
    return null;
  }
  try {
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
    logError("analysis provider init failed", {
      requestId: res.locals.requestId ?? null,
      workspace: res.locals.workspaceId ?? null,
      postId,
      ...describeAiError(err),
    });
    res.status(503).json({ error: err instanceof Error ? err.message : "AI provider error" });
    return null;
  }
}

analysisRouter.post("/", async (req, res) => {
  const request = await resolveAnalysisRequest(req, res);
  if (!request) return;

  logInfo("analysis started", {
    requestId: res.locals.requestId ?? null,
    workspace: res.locals.workspaceId ?? null,
    postId: request.postId,
    promptName: request.promptName,
    contentSource: request.contentSource,
    contentLength: request.postContent.length,
    promptMode: request.promptMode,
    language: request.post.frontMatter.language,
    target: request.post.frontMatter.target,
    metadataKeys: metadataKeys(request.post.frontMatter),
    ai: safeAiConfigLogContext(request.aiConfig),
    post: safePostLogContext(request.post),
    systemLength: request.systemPrompt.length,
    userLength: request.userContent.length,
  });

  try {
    const result = await request.provider.generateText(
      request.systemPrompt,
      request.userContent
    );
    logInfo("analysis completed", {
      requestId: res.locals.requestId ?? null,
      workspace: res.locals.workspaceId ?? null,
      postId: request.postId,
      resultLength: result.length,
    });
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

  // The response is a stream of newline-delimited JSON frames:
  //   {"type":"delta","text":"..."}   incremental output
  //   {"type":"done"}                 the model completed normally
  //   {"type":"error","message":"..."} the generation failed mid-stream
  // The explicit `done`/`error` framing is what lets the client tell a complete
  // analysis from one cut short — a raw text body cannot, because once bytes are
  // sent the HTTP status is already 200 and a late failure looks like success.
  let clientClosed = false;
  let headerWritten = false;
  let wroteDelta = false;
  logInfo("analysis stream started", {
    requestId: res.locals.requestId ?? null,
    workspace: res.locals.workspaceId ?? null,
    postId: request.postId,
    promptName: request.promptName,
    contentSource: request.contentSource,
    contentLength: request.postContent.length,
    promptMode: request.promptMode,
    language: request.post.frontMatter.language,
    target: request.post.frontMatter.target,
    metadataKeys: metadataKeys(request.post.frontMatter),
    ai: safeAiConfigLogContext(request.aiConfig),
    post: safePostLogContext(request.post),
  });

  type StreamFrame =
    | { type: "delta"; text: string }
    | { type: "done" }
    | { type: "error"; message: string };
  const writeFrame = (frame: StreamFrame): void => {
    if (!headerWritten) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      headerWritten = true;
    }
    res.write(JSON.stringify(frame) + "\n");
  };

  const stream = request.provider.generateTextStream(
    request.systemPrompt,
    request.userContent,
    (delta) => {
      if (clientClosed || delta.length === 0) return;
      wroteDelta = true;
      writeFrame({ type: "delta", text: delta });
    }
  );

  const closeHandler = () => {
    if (res.writableEnded) return;
    clientClosed = true;
    stream.abort();
    logWarn("analysis stream closed early", {
      requestId: res.locals.requestId ?? null,
      workspace: res.locals.workspaceId ?? null,
      postId: request.postId,
      promptName: request.promptName,
      wroteDelta,
    });
  };
  req.on("close", closeHandler);

  try {
    const finalText = await stream.finished;
    if (clientClosed) return;
    // Robustness: if the provider produced text without emitting incremental
    // events, send it as one delta before closing.
    if (!wroteDelta && finalText) writeFrame({ type: "delta", text: finalText });
    writeFrame({ type: "done" });
    logInfo("analysis stream completed", {
      requestId: res.locals.requestId ?? null,
      workspace: res.locals.workspaceId ?? null,
      postId: request.postId,
      wroteDelta,
      resultLength: finalText.length,
    });
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
          wroteDelta,
        },
      },
      err
    );
    const message = err instanceof Error ? err.message : details;
    if (!headerWritten) {
      // Nothing sent yet: a plain HTTP error the client surfaces as a failure.
      res.status(502).json({ error: message });
      return;
    }
    // Bytes already streamed: tell the client explicitly so the partial text is
    // never mistaken for a complete analysis.
    writeFrame({ type: "error", message });
    res.end();
  } finally {
    req.off("close", closeHandler);
  }
});
