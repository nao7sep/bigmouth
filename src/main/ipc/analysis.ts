import { authorizedRoleCall } from "../authorizedAiCall.js";
import { ipcMain } from "electron";

import { CHANNELS, analysisStreamChannel, type AnalysisStreamFrame, type AnalysisStreamParams } from "@shared/ipc";
import type { Workspace } from "@shared/types";
import { getPost } from "../storageAccess.js";
import { getAnalysisPrompts } from "../storageAccess.js";
import { createProvider } from "../core/ai/factory.js";
import { resolvePromptRequest, usesContentPlaceholder } from "../core/ai/promptTemplates.js";
import { logAiFailure } from "../core/ai/errorDetails.js";
import { debug as logDebug, info as logInfo } from "../core/services/logger.js";
import { maskCredentials } from "../core/ai/maskCredentials.js";
import { resolveWorkspace } from "./context.js";
import { trackAiRequest } from "./aiRequests.js";

async function resolveAnalysisRequest(
  ws: Workspace,
  params: { postId?: string; promptName?: string; content?: string },
  operationId: string,
) {
  const dir = ws.dataDirectory;
  const { postId, promptName, content } = params;
  if (!postId || !promptName) throw new Error("postId and promptName are required");

  const post = (await getPost(dir, postId));
  if (!post) throw new Error("Post not found");

  const prompt = (await getAnalysisPrompts(dir)).find((p) => p.name === promptName);
  if (!prompt) throw new Error(`Analysis prompt not found: ${promptName}`);

  const postContent = content?.trim() ? content : post.content;
  const contentSource = content?.trim() ? "request" : "stored";
  const { systemPrompt, userContent } = resolvePromptRequest(prompt.text, { content: postContent });
  const promptMode = usesContentPlaceholder(prompt.text) ? "inline-content" : "split-system-user";

  const roleCall = (await authorizedRoleCall(ws, "analysis"));
  let provider;
  try {
    provider = createProvider(roleCall, { operationId, workspaceId: ws.id, postId, purpose: "analysis" });
  } catch (err) {
    const message = logAiFailure(
      { kind: "analysis provider init", workspaceId: ws.id, postId, apiKey: roleCall.apiKey, extra: { operationId } },
      err,
    );
    throw new Error(message);
  }

  return { postId, promptName, post, postContent, contentSource, promptMode, systemPrompt, userContent, roleCall, provider };
}

export function registerAnalysisHandlers(): void {
  // The renderer subscribes to analysisStreamChannel(requestId) BEFORE invoking
  // this, so no early frame is missed. Validation throws (rejecting the invoke);
  // otherwise the stream is started and frames are pushed async on the channel.
  ipcMain.handle(CHANNELS.analysisStreamStart, async (event, requestId: string, params: AnalysisStreamParams) => {
    let aborted = false;
    let stream: ReturnType<ReturnType<typeof createProvider>["generateTextStream"]> | null = null;
    const release = trackAiRequest(event.sender, requestId, () => { aborted = true; stream?.abort(); });
    try {
    const ws = (await resolveWorkspace(params.wsId));
    const request = (await resolveAnalysisRequest(ws, params, requestId));
    if (aborted) { release(); return; }
    const channel = analysisStreamChannel(requestId);
    const send = (frame: AnalysisStreamFrame): void => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, frame);
    };

    logInfo("analysis stream started", maskCredentials({
      operationId: requestId,
      workspace: params.wsId,
      postId: request.postId,
      promptName: request.promptName,
      contentSource: request.contentSource,
      contentLength: request.postContent.length,
      promptMode: request.promptMode,
      model: request.roleCall.model,
      thinking: request.roleCall.thinking ?? null,
    }, [request.roleCall.apiKey]));

    let wroteDelta = false;
    stream = request.provider.generateTextStream(
      request.systemPrompt,
      request.userContent,
      (delta) => {
        if (aborted || delta.length === 0) return;
        wroteDelta = true;
        // Per chunk: `debug` by the frequency rule, and the only record of how a
        // stream actually arrived when one stalls or ends early.
        logDebug("analysis delta", maskCredentials({ operationId: requestId, length: delta.length }, [request.roleCall.apiKey]));
        send({ type: "delta", text: delta });
      },
      (delta) => {
        // Reasoning, not answer — deliberately not counted as wroteDelta, so a run that
        // only ever thinks still takes the no-output path below.
        if (aborted || delta.length === 0) return;
        send({ type: "thinking", text: delta });
      },
    );

    void stream.finished
      .then((finalText) => {
        if (aborted) return;
        // Robustness: a provider that produced text without incremental events.
        if (!wroteDelta && finalText) send({ type: "delta", text: finalText });
        send({ type: "done" });
        logInfo("analysis stream completed", maskCredentials({
          operationId: requestId,
          workspace: params.wsId,
          postId: request.postId,
          wroteDelta,
          resultLength: finalText.length,
        }, [request.roleCall.apiKey]));
      })
      .catch((err: unknown) => {
        if (aborted) return;
        const message = logAiFailure(
          {
            kind: "Analysis stream",
            apiKey: request.roleCall.apiKey,
            workspaceId: params.wsId,
            postId: request.postId,
            promptName: request.promptName,
            extra: {
              operationId: requestId,
              contentSource: request.contentSource,
              contentLength: request.postContent.length,
              promptMode: request.promptMode,
              model: request.roleCall.model,
              wroteDelta,
            },
          },
          err,
        );
        send({ type: "error", message });
      })
      .finally(release);
    } catch (error) { release(); throw error; }
  });
}
