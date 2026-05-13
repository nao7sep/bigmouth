/**
 * POST /api/w/:wsId/analyze
 * Runs a named prompt against the post content using the configured AI provider.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { getPost } from "../services/postStore.js";
import { getAnalysisPrompts, getAiConfigsForServer } from "../services/configStore.js";
import { createProvider } from "../ai/factory.js";
import { resolvePromptRequest } from "../ai/promptTemplates.js";
import { error as logError } from "../services/logger.js";

export const analysisRouter = Router({ mergeParams: true });

async function resolveAnalysisRequest(
  req: Request,
  res: Response
): Promise<
  | {
      postId: string;
      systemPrompt: string;
      userContent: string;
      provider: ReturnType<typeof createProvider>;
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
      return null;
    }
    return {
      postId,
      systemPrompt,
      userContent,
      provider: createProvider(activeConfig),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI provider error";
    logError(`AI provider init failed for post ${postId}: ${msg}`);
    res.status(503).json({ error: msg });
    return null;
  }
}

analysisRouter.post("/", async (req, res) => {
  const request = await resolveAnalysisRequest(req, res);
  if (!request) return;

  try {
    const result = await request.provider.generateText(
      request.systemPrompt,
      request.userContent
    );
    res.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    logError(`AI analysis failed for post ${request.postId}: ${msg}`);
    res.status(502).json({ error: msg });
  }
});

analysisRouter.post("/stream", async (req, res) => {
  const request = await resolveAnalysisRequest(req, res);
  if (!request) return;

  let clientClosed = false;
  let wroteChunk = false;
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
    clientClosed = true;
    stream.abort();
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
    res.end();
  } catch (err) {
    if (clientClosed) return;
    const msg = err instanceof Error ? err.message : "AI request failed";
    logError(`AI analysis stream failed for post ${request.postId}: ${msg}`);
    if (!res.headersSent) {
      res.status(502).type("text/plain").send(msg);
      return;
    }
    res.end();
  } finally {
    req.off("close", closeHandler);
  }
});
