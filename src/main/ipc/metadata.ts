import { ipcMain } from "electron";

import { CHANNELS, type MetadataGenerationResults } from "@shared/ipc";
import { getPost } from "../core/services/postStore.js";
import { getGenerationPrompts, getActiveAiConfig } from "../core/services/configStore.js";
import { createProvider } from "../core/ai/factory.js";
import {
  buildMetadataGenerationRequest,
  isMetadataField,
  metadataValueToClientString,
  normalizeGeneratedMetadata,
  normalizeMetadataFields,
  type MetadataField,
} from "../core/ai/metadataGeneration.js";
import { describeAiError, logAiFailure } from "../core/ai/errorDetails.js";
import { metadataKeys, safeAiConfigLogContext, safeGeneratedFieldSummary } from "../core/shared/logSummaries.js";
import { info as logInfo, error as logError } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";
import { trackAiRequest } from "./aiRequests.js";

// A generous outer cap, not the bound that matters: the call is bounded by
// inactivity in the provider, so a thinking-enabled config that is still
// producing output is never cut off after its tokens are billed, and the user
// can stop it at any time.
const METADATA_GENERATION_MAX_MS = 10 * 60_000;
// This app's retry policy for the call (the client itself never retries): one
// retry, which the SDK makes only when no response arrived or the API answered
// with a retryable status such as overloaded — never after an abort, so neither
// the user's Stop nor the inactivity watchdog can resend a billed request.
const METADATA_GENERATION_MAX_RETRIES = 1;

export function registerMetadataHandlers(): void {
  ipcMain.handle(
    CHANNELS.generateMetadata,
    async (event, requestId: string, wsId: string, postId: string, fields: string[], content: string) => {
      // Registered before the first await, so an abort sent right after the
      // request can never arrive ahead of it (see aiRequests.ts).
      const cancel = new AbortController();
      const release = trackAiRequest(event.sender, requestId, () => cancel.abort());
      try {
        return await generateMetadata(wsId, postId, fields, content, cancel.signal);
      } finally {
        release();
      }
    },
  );
}

async function generateMetadata(
  wsId: string,
  postId: string,
  fields: string[],
  content: string,
  signal: AbortSignal,
): Promise<MetadataGenerationResults> {
  const ws = resolveWorkspace(wsId);
  const dir = ws.dataDirectory;
  if (!postId || !Array.isArray(fields) || fields.length === 0) {
    throw new Error("postId and fields[] are required");
  }

  const results: MetadataGenerationResults = {};
  for (const field of fields) {
    if (!isMetadataField(field)) results[field] = { error: `Field is not generatable: ${field}` };
  }
  const validFields = normalizeMetadataFields(fields);
  if (validFields.length === 0) return results;

  const post = getPost(dir, postId);
  if (!post) throw new Error("Post not found");
  const activeConfig = getActiveAiConfig(ws);
  if (!activeConfig) throw new Error("No active AI configuration selected");
  let provider;
  try {
    provider = createProvider(activeConfig);
  } catch (err) {
    logError("metadata generation provider init failed", { workspace: wsId, postId, ...describeAiError(err) });
    throw err instanceof Error ? err : new Error("AI provider error");
  }

  const postContent = content?.trim() ? content : post.content;
  const contentSource = content?.trim() ? "request" : "stored";
  const customPrompts = getGenerationPrompts(dir).prompts;

  logInfo("metadata generation started", {
    workspace: wsId,
    postId,
    fields: validFields,
    mode: "structured",
    contentSource,
    contentLength: postContent.length,
    language: post.frontMatter.language,
    target: post.frontMatter.target,
    existingMetadataKeys: metadataKeys(post.frontMatter),
    ai: safeAiConfigLogContext(activeConfig),
  });

  try {
    const request = buildMetadataGenerationRequest({
      fields: validFields,
      content: postContent,
      frontMatter: post.frontMatter,
      customPrompts,
    });
    const raw = await provider.generateJson(request.systemPrompt, request.userContent, request.schema, {
      maxDurationMs: METADATA_GENERATION_MAX_MS,
      maxRetries: METADATA_GENERATION_MAX_RETRIES,
      signal,
    });
    const generated = normalizeGeneratedMetadata(raw, validFields);
    const values = {} as Record<MetadataField, string>;
    for (const field of validFields) {
      const value = generated[field];
      if (value === undefined) throw new Error(`Structured metadata response omitted ${field}`);
      values[field] = metadataValueToClientString(value);
      results[field] = { value: values[field] };
    }
    logInfo("metadata generation completed", {
      workspace: wsId,
      postId,
      fields: validFields,
      mode: "structured",
      resultSummary: safeGeneratedFieldSummary(values),
    });
  } catch (err) {
    if (signal.aborted) {
      // The user stopped it, or its window went away: not a failure to report.
      logInfo("metadata generation cancelled", { workspace: wsId, postId, fields: validFields });
      throw new Error("Metadata generation was cancelled.");
    }
    const details = logAiFailure(
      {
        kind: "Metadata generation",
        workspaceId: wsId,
        postId,
        extra: {
          fields: validFields,
          mode: "structured",
          maxDurationMs: METADATA_GENERATION_MAX_MS,
          maxRetries: METADATA_GENERATION_MAX_RETRIES,
          contentSource,
          contentLength: postContent.length,
          language: post.frontMatter.language,
          target: post.frontMatter.target,
          existingMetadataKeys: metadataKeys(post.frontMatter),
          ai: safeAiConfigLogContext(activeConfig),
        },
      },
      err,
    );
    const message = err instanceof Error ? err.message : details;
    for (const field of validFields) results[field] = { error: message };
  }

  return results;
}
