import { ipcMain } from "electron";

import { CHANNELS, analysisStreamChannel, type AnalysisStreamFrame, type AnalysisStreamParams } from "@shared/ipc";
import type { Workspace } from "@shared/types";
import { getPost } from "../core/services/postStore.js";
import { getAnalysisPrompts, getActiveAiConfig } from "../core/services/configStore.js";
import { createProvider } from "../core/ai/factory.js";
import { resolvePromptRequest, usesContentPlaceholder } from "../core/ai/promptTemplates.js";
import { describeAiError, logAiFailure } from "../core/ai/errorDetails.js";
import { safeAiConfigLogContext, safePostLogContext } from "../core/shared/logSummaries.js";
import { info as logInfo, warn as logWarn, error as logError } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

// In-flight streams keyed by the renderer-supplied request id, so an abort
// message can cancel the matching generation. The renderer holds its abort until
// the start invoke has resolved (see preload), so an abort can never reach this
// process before the stream is registered. An abort for an id that is no longer
// active therefore means the stream has already finished, and is safely ignored.
const activeStreams = new Map<string, { abort: () => void }>();

function resolveAnalysisRequest(
  ws: Workspace,
  params: { postId?: string; promptName?: string; content?: string },
) {
  const dir = ws.dataDirectory;
  const { postId, promptName, content } = params;
  if (!postId || !promptName) throw new Error("postId and promptName are required");

  const post = getPost(dir, postId);
  if (!post) throw new Error("Post not found");

  const prompt = getAnalysisPrompts(dir).find((p) => p.name === promptName);
  if (!prompt) throw new Error(`Analysis prompt not found: ${promptName}`);

  const postContent = content?.trim() ? content : post.content;
  const contentSource = content?.trim() ? "request" : "stored";
  const { systemPrompt, userContent } = resolvePromptRequest(prompt.text, { content: postContent });
  const promptMode = usesContentPlaceholder(prompt.text) ? "inline-content" : "split-system-user";

  const aiConfig = getActiveAiConfig(ws);
  if (!aiConfig) throw new Error("No active AI configuration selected");

  let provider;
  try {
    provider = createProvider(aiConfig);
  } catch (err) {
    logError("analysis provider init failed", { workspace: ws.id, postId, ...describeAiError(err) });
    throw err instanceof Error ? err : new Error("AI provider error");
  }

  return { postId, promptName, post, postContent, contentSource, promptMode, systemPrompt, userContent, aiConfig, provider };
}

export function registerAnalysisHandlers(): void {
  // The renderer subscribes to analysisStreamChannel(requestId) BEFORE invoking
  // this, so no early frame is missed. Validation throws (rejecting the invoke);
  // otherwise the stream is started and frames are pushed async on the channel.
  ipcMain.handle(CHANNELS.analysisStreamStart, (event, requestId: string, params: AnalysisStreamParams) => {
    const ws = resolveWorkspace(params.wsId);
    const request = resolveAnalysisRequest(ws, params);
    const channel = analysisStreamChannel(requestId);
    const send = (frame: AnalysisStreamFrame): void => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, frame);
    };

    logInfo("analysis stream started", {
      workspace: params.wsId,
      postId: request.postId,
      promptName: request.promptName,
      contentSource: request.contentSource,
      contentLength: request.postContent.length,
      promptMode: request.promptMode,
      ai: safeAiConfigLogContext(request.aiConfig),
      post: safePostLogContext(request.post),
    });

    let wroteDelta = false;
    let aborted = false;
    const stream = request.provider.generateTextStream(request.systemPrompt, request.userContent, (delta) => {
      if (aborted || delta.length === 0) return;
      wroteDelta = true;
      send({ type: "delta", text: delta });
    });

    activeStreams.set(requestId, {
      abort: () => {
        aborted = true;
        stream.abort();
        logWarn("analysis stream aborted", { workspace: params.wsId, postId: request.postId, wroteDelta });
      },
    });

    void stream.finished
      .then((finalText) => {
        if (aborted) return;
        // Robustness: a provider that produced text without incremental events.
        if (!wroteDelta && finalText) send({ type: "delta", text: finalText });
        send({ type: "done" });
        logInfo("analysis stream completed", {
          workspace: params.wsId,
          postId: request.postId,
          wroteDelta,
          resultLength: finalText.length,
        });
      })
      .catch((err: unknown) => {
        if (aborted) return;
        const message = logAiFailure(
          {
            kind: "Analysis stream",
            workspaceId: params.wsId,
            postId: request.postId,
            promptName: request.promptName,
            extra: {
              contentSource: request.contentSource,
              contentLength: request.postContent.length,
              promptMode: request.promptMode,
              ai: safeAiConfigLogContext(request.aiConfig),
              wroteDelta,
            },
          },
          err,
        );
        send({ type: "error", message: err instanceof Error ? err.message : message });
      })
      .finally(() => {
        activeStreams.delete(requestId);
      });
  });

  ipcMain.on(CHANNELS.analysisStreamAbort, (_event, requestId: string) => {
    const active = activeStreams.get(requestId);
    if (!active) return; // already finished, or never registered — nothing to cancel
    active.abort();
    activeStreams.delete(requestId);
  });
}
