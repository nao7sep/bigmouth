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

const IMAGING_GENERATION_TIMEOUT_MS = 60_000;
const IMAGING_GENERATION_MAX_RETRIES = 1;
const IMAGING_GENERATION_MAX_TOKENS = 4096;

export function registerImagingHandlers(): void {
  ipcMain.handle(
    CHANNELS.generateImaging,
    async (_event, wsId: string, postId: string, content: string, options: ImagingOptions) => {
      const dir = resolveWorkspace(wsId).dataDirectory;
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

      const activeConfig = getActiveAiConfig(dir);
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
          timeoutMs: IMAGING_GENERATION_TIMEOUT_MS,
          maxRetries: IMAGING_GENERATION_MAX_RETRIES,
          maxTokens: IMAGING_GENERATION_MAX_TOKENS,
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
        const details = logAiFailure(
          {
            kind: "Imaging",
            workspaceId: wsId,
            postId,
            extra: {
              ...options,
              mode: "structured",
              timeoutMs: IMAGING_GENERATION_TIMEOUT_MS,
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
    },
  );
}
