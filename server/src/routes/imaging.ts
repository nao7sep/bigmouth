import { Router } from "express";
import { getPost } from "../services/postStore.js";
import { getAiConfigsForServer } from "../services/configStore.js";
import { createProvider } from "../ai/factory.js";
import { error as logError, info as logInfo, logBlock } from "../services/logger.js";
import {
  buildImagingSystemPrompt,
  buildImagingUserContent,
  IMAGING_COUNTS,
  IMAGING_MOODS,
  IMAGING_LITERALNESS,
  IMAGING_PEOPLE,
  IMAGING_RELATIONS,
  IMAGING_STYLES,
  type ImagingOptions,
} from "../ai/imaging.js";
import { parseJsonCandidates } from "../ai/jsonResponse.js";
import { describeAiError, logAiFailure } from "../ai/errorDetails.js";

export const imagingRouter = Router({ mergeParams: true });

function normalizePromptList(items: unknown): string[] | null {
  if (!Array.isArray(items)) return null;
  const normalized = items
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : null;
}

function parseImagingResponse(raw: string): string[] {
  for (const parsed of parseJsonCandidates(raw)) {
    const direct = normalizePromptList(parsed);
    if (direct) return direct;

    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["items", "prompts", "value"]) {
        const extracted = normalizePromptList(record[key]);
        if (extracted) return extracted;
      }
    }
  }

  throw new Error("Generated prompts were not valid JSON");
}

imagingRouter.post("/", async (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const {
    postId,
    content,
    count,
    relation,
    emotionalLens,
    literalness,
    people,
    style,
  } = req.body as {
    postId?: string;
    content?: string;
    count?: number;
    relation?: string;
    emotionalLens?: string;
    literalness?: string;
    people?: string;
    style?: string;
  };

  if (!postId) {
    res.status(400).json({ error: "postId is required" });
    return;
  }

  const post = getPost(dataDir, postId);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  const options: ImagingOptions = {
    count:
      typeof count === "number" && IMAGING_COUNTS.includes(count as (typeof IMAGING_COUNTS)[number])
        ? count
        : 5,
    relation:
      typeof relation === "string" &&
      IMAGING_RELATIONS.includes(relation as (typeof IMAGING_RELATIONS)[number])
        ? (relation as ImagingOptions["relation"])
        : "domain",
    emotionalLens:
      typeof emotionalLens === "string" &&
      IMAGING_MOODS.includes(emotionalLens as (typeof IMAGING_MOODS)[number])
        ? (emotionalLens as ImagingOptions["emotionalLens"])
        : "hopeful",
    literalness:
      typeof literalness === "string" &&
      IMAGING_LITERALNESS.includes(literalness as (typeof IMAGING_LITERALNESS)[number])
        ? (literalness as ImagingOptions["literalness"])
        : "stylized",
    people:
      typeof people === "string" &&
      IMAGING_PEOPLE.includes(people as (typeof IMAGING_PEOPLE)[number])
        ? (people as ImagingOptions["people"])
        : "mixed",
    style:
      typeof style === "string" &&
      IMAGING_STYLES.includes(style as (typeof IMAGING_STYLES)[number])
        ? (style as ImagingOptions["style"])
        : "illustration",
  };

  const postContent = content?.trim() ? content : post.content;
  const systemPrompt = buildImagingSystemPrompt(options.count);
  const userContent = buildImagingUserContent(postContent, options, {
    targetName: post.frontMatter.target,
  });

  let provider;
  try {
    const aiConfigs = getAiConfigsForServer(dataDir);
    const activeConfig = aiConfigs.configs.find((c) => c.id === aiConfigs.activeId);
    if (!activeConfig) {
      res.status(503).json({ error: "No active AI configuration selected" });
      return;
    }
    provider = createProvider(activeConfig);
  } catch (err) {
    const details = describeAiError(err);
    logError(
      `Imaging provider init failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, ${details}`
    );
    res.status(503).json({ error: err instanceof Error ? err.message : "Request failed" });
    return;
  }

  logInfo(
    `Imaging started: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, options=${JSON.stringify(options)}, systemLength=${systemPrompt.length}, userLength=${userContent.length}`
  );

  try {
    const raw = await provider.generateText(systemPrompt, userContent);
    let items: string[];
    try {
      items = parseImagingResponse(raw);
    } catch (err) {
      logBlock(
        "ERROR",
        `Imaging JSON parse failure: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, rawLength=${raw.length}`,
        raw
      );
      throw err;
    }
    logInfo(
      `Imaging completed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${postId}, itemCount=${items.length}, rawLength=${raw.length}`
    );
    res.json({ items });
  } catch (err) {
    const details = logAiFailure(
      {
        kind: "Imaging",
        requestId: res.locals.requestId,
        workspaceId: res.locals.workspaceId,
        postId,
        extra: options,
      },
      err,
      {
        systemPrompt,
        userContent,
      }
    );
    res.status(502).json({ error: err instanceof Error ? err.message : details });
  }
});
