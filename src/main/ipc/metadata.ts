import { authorizedRoleCall } from "../authorizedAiCall.js";
import { ipcMain } from "electron";

import { CHANNELS, type MetadataGenerationResults } from "@shared/ipc";
import { getPost } from "../storageAccess.js";
import { getGenerationPrompts } from "../storageAccess.js";
import { createProvider } from "../core/ai/factory.js";
import {
  buildMetadataGenerationRequest,
  isMetadataField,
  metadataValueToClientString,
  normalizeGeneratedMetadata,
  normalizeMetadataFields,
  type MetadataField,
} from "../core/ai/metadataGeneration.js";
import { logAiFailure } from "../core/ai/errorDetails.js";
import { info as logInfo } from "../core/services/logger.js";
import { maskCredentials } from "../core/ai/maskCredentials.js";
import { resolveWorkspace } from "./context.js";
import { trackAiRequest } from "./aiRequests.js";
import { GENERATION_MAX_MS } from "../core/ai/provider.js";

export function registerMetadataHandlers(): void {
  ipcMain.handle(
    CHANNELS.generateMetadata,
    async (event, requestId: string, wsId: string, postId: string, fields: string[], content: string) => {
      // Registered before the first await, so an abort sent right after the
      // request can never arrive ahead of it.
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
  const ws = (await resolveWorkspace(wsId));
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

  const post = (await getPost(dir, postId));
  if (!post) throw new Error("Post not found");
  const roleCall = (await authorizedRoleCall(ws, "metadata"));
  let provider;
  try {
    provider = createProvider(roleCall, { workspaceId: ws.id, postId, purpose: "metadata" });
  } catch (err) {
    const message = logAiFailure(
      { kind: "metadata generation provider init", workspaceId: ws.id, postId, apiKey: roleCall.apiKey },
      err,
    );
    throw new Error(message);
  }

  const postContent = content?.trim() ? content : post.content;
  const contentSource = content?.trim() ? "request" : "stored";
  const customPrompts = (await getGenerationPrompts(dir)).prompts;

  try {
    const request = buildMetadataGenerationRequest({
      fields: validFields,
      content: postContent,
      frontMatter: post.frontMatter,
      customPrompts,
    });
    logInfo("metadata generation started", maskCredentials({
      workspace: wsId,
      postId,
      fields: validFields,
      mode: "structured",
      contentSource,
      contentLength: postContent.length,
      language: post.frontMatter.language,
      target: post.frontMatter.target,
      frontMatter: post.frontMatter,
      model: roleCall.model,
      thinking: roleCall.thinking ?? null,
      systemPrompt: request.systemPrompt,
      userContent: request.userContent,
      schema: request.schema,
    }, [roleCall.apiKey]));
    signal.throwIfAborted();
    const raw = await provider.generateJson(request.systemPrompt, request.userContent, request.schema, {
      maxDurationMs: GENERATION_MAX_MS,
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
    logInfo("metadata generation completed", maskCredentials({
      workspace: wsId,
      postId,
      fields: validFields,
      mode: "structured",
      result: raw,
    }, [roleCall.apiKey]));
  } catch (err) {
    if (signal.aborted) {
      // The user stopped it, or its window went away: not a failure to report.
      logInfo("metadata generation cancelled", maskCredentials({ workspace: wsId, postId, fields: validFields }, [roleCall.apiKey]));
      throw new Error("Metadata generation was cancelled.");
    }
    const message = logAiFailure(
      {
        kind: "Metadata generation",
        apiKey: roleCall.apiKey,
        workspaceId: wsId,
        postId,
        extra: {
          fields: validFields,
          mode: "structured",
          maxDurationMs: GENERATION_MAX_MS,
          contentSource,
          contentLength: postContent.length,
          language: post.frontMatter.language,
          target: post.frontMatter.target,
          model: roleCall.model,
        },
      },
      err,
    );
    for (const field of validFields) results[field] = { error: message };
  }

  return results;
}
