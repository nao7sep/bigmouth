import { authorizedRoleCall } from "../authorizedAiCall.js";
import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import { getPost } from "../storageAccess.js";
import { createProvider } from "../core/ai/factory.js";
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
} from "../core/ai/imaging.js";
import { logAiFailure } from "../core/ai/errorDetails.js";
import { info as logInfo } from "../core/services/logger.js";
import { maskCredentials } from "../core/ai/maskCredentials.js";
import { resolveWorkspace } from "./context.js";
import { trackAiRequest } from "./aiRequests.js";
import { GENERATION_MAX_MS } from "../core/ai/provider.js";

export function registerImagingHandlers(): void {
  ipcMain.handle(
    CHANNELS.generateImaging,
    async (event, requestId: string, wsId: string, postId: string, content: string, options: ImagingOptions) => {
      // Registered before the first await, so an abort sent right after the
      // request can never arrive ahead of it.
      const cancel = new AbortController();
      const release = trackAiRequest(event.sender, requestId, () => cancel.abort());
      try {
        return await generateImaging(wsId, postId, content, options, cancel.signal);
      } finally {
        release();
      }
    },
  );
}

async function generateImaging(
  wsId: string,
  postId: string,
  content: string,
  options: ImagingOptions,
  signal: AbortSignal,
): Promise<string[]> {
  const ws = (await resolveWorkspace(wsId));
  const dir = ws.dataDirectory;
  if (!postId) throw new Error("postId is required");
  const post = (await getPost(dir, postId));
  if (!post) throw new Error("Post not found");

  // Reject out-of-set option values rather than silently coercing them.
  const o = options as unknown as Record<string, unknown>;
  const optionErrors: string[] = [];
  if (!IMAGING_COUNTS.includes(o.count as (typeof IMAGING_COUNTS)[number])) optionErrors.push("count");
  if (!IMAGING_RELATIONS.includes(o.relation as (typeof IMAGING_RELATIONS)[number])) optionErrors.push("relation");
  if (!IMAGING_MOODS.includes(o.emotionalLens as (typeof IMAGING_MOODS)[number])) optionErrors.push("emotionalLens");
  if (!IMAGING_LITERALNESS.includes(o.literalness as (typeof IMAGING_LITERALNESS)[number])) optionErrors.push("literalness");
  if (!IMAGING_PEOPLE.includes(o.people as (typeof IMAGING_PEOPLE)[number])) optionErrors.push("people");
  if (!IMAGING_STYLES.includes(o.style as (typeof IMAGING_STYLES)[number])) optionErrors.push("style");
  if (optionErrors.length > 0) {
    throw new Error(`Invalid imaging option(s): ${optionErrors.join(", ")}`);
  }

  const postContent = content?.trim() ? content : post.content;
  const systemPrompt = buildImagingSystemPrompt(options.count);
  const userContent = buildImagingUserContent(postContent, options, {
    targetName: post.frontMatter.target,
    frontMatter: post.frontMatter,
  });

  const roleCall = (await authorizedRoleCall(ws, "imagingPrompts"));
  let provider;
  try {
    provider = createProvider(roleCall, { workspaceId: ws.id, postId, purpose: "imaging" });
  } catch (err) {
    const message = logAiFailure(
      { kind: "imaging provider init", workspaceId: ws.id, postId, apiKey: roleCall.apiKey },
      err,
    );
    throw new Error(message);
  }

  logInfo("imaging started", maskCredentials({
    workspace: wsId,
    postId,
    options,
    mode: "structured",
    contentLength: postContent.length,
    frontMatter: post.frontMatter,
    model: roleCall.model,
    thinking: roleCall.thinking ?? null,
    systemPrompt,
    userContent,
  }, [roleCall.apiKey]));

  try {
    signal.throwIfAborted();
    const raw = await provider.generateJson(systemPrompt, userContent, buildImagingSchema(options.count), {
      maxDurationMs: GENERATION_MAX_MS,
      signal,
    });
    const items = normalizeImagingOutput(raw, options.count);
    logInfo("imaging completed", maskCredentials({
      workspace: wsId,
      postId,
      itemCount: items.length,
      mode: "structured",
      result: raw,
    }, [roleCall.apiKey]));
    return items;
  } catch (err) {
    if (signal.aborted) {
      // The user stopped it, or its window went away: not a failure to report.
      logInfo("imaging cancelled", maskCredentials({ workspace: wsId, postId }, [roleCall.apiKey]));
      throw new Error("Imaging was cancelled.");
    }
    const details = logAiFailure(
      {
        kind: "Imaging",
        apiKey: roleCall.apiKey,
        workspaceId: wsId,
        postId,
        extra: {
          ...options,
          mode: "structured",
          maxDurationMs: GENERATION_MAX_MS,
          contentLength: postContent.length,
          model: roleCall.model,
        },
      },
      err,
    );
    throw new Error(details);
  }
}
