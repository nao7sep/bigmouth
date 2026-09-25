import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import { getPost } from "../core/services/postStore.js";
import { getActiveAiConfig } from "../core/services/configStore.js";
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
import { describeAiError, logAiFailure } from "../core/ai/errorDetails.js";
import { metadataKeys, safeAiConfigLogContext, safePromptListSummary } from "../core/shared/logSummaries.js";
import { info as logInfo, error as logError } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";
import { trackAiRequest } from "./aiRequests.js";

// A generous outer cap, not the bound that matters: the call is bounded by
// inactivity in the provider, so a thinking-enabled config that is still
// producing output is never cut off after its tokens are billed, and the user
// can stop it at any time.
const IMAGING_GENERATION_MAX_MS = 10 * 60_000;
// This app's retry policy for the call (the client itself never retries): one
// retry, which the SDK makes only when no response arrived or the API answered
// with a retryable status such as overloaded — never after an abort, so neither
// the user's Stop nor the inactivity watchdog can resend a billed request.
const IMAGING_GENERATION_MAX_RETRIES = 1;

export function registerImagingHandlers(): void {
  ipcMain.handle(
    CHANNELS.generateImaging,
    async (event, requestId: string, wsId: string, postId: string, content: string, options: ImagingOptions) => {
      // Registered before the first await, so an abort sent right after the
      // request can never arrive ahead of it (see aiRequests.ts).
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
  const ws = resolveWorkspace(wsId);
  const dir = ws.dataDirectory;
  if (!postId) throw new Error("postId is required");
  const post = getPost(dir, postId);
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

  const activeConfig = getActiveAiConfig(ws);
  if (!activeConfig) throw new Error("No active AI configuration selected");
  let provider;
  try {
    provider = createProvider(activeConfig);
  } catch (err) {
    logError("imaging provider init failed", { workspace: wsId, postId, ...describeAiError(err) });
    throw err instanceof Error ? err : new Error("Request failed");
  }

  logInfo("imaging started", {
    workspace: wsId,
    postId,
    options,
    mode: "structured",
    contentLength: postContent.length,
    metadataKeys: metadataKeys(post.frontMatter),
    ai: safeAiConfigLogContext(activeConfig),
    systemLength: systemPrompt.length,
    userLength: userContent.length,
  });

  try {
    const raw = await provider.generateJson(systemPrompt, userContent, buildImagingSchema(options.count), {
      maxDurationMs: IMAGING_GENERATION_MAX_MS,
      maxRetries: IMAGING_GENERATION_MAX_RETRIES,
      signal,
    });
    const items = normalizeImagingOutput(raw, options.count);
    logInfo("imaging completed", {
      workspace: wsId,
      postId,
      itemCount: items.length,
      mode: "structured",
      promptSummary: safePromptListSummary(items),
    });
    return items;
  } catch (err) {
    if (signal.aborted) {
      // The user stopped it, or its window went away: not a failure to report.
      logInfo("imaging cancelled", { workspace: wsId, postId });
      throw new Error("Imaging was cancelled.");
    }
    const details = logAiFailure(
      {
        kind: "Imaging",
        workspaceId: wsId,
        postId,
        extra: {
          ...options,
          mode: "structured",
          maxDurationMs: IMAGING_GENERATION_MAX_MS,
          maxRetries: IMAGING_GENERATION_MAX_RETRIES,
          contentLength: postContent.length,
          metadataKeys: metadataKeys(post.frontMatter),
          ai: safeAiConfigLogContext(activeConfig),
        },
      },
      err,
    );
    throw new Error(err instanceof Error ? err.message : details);
  }
}
