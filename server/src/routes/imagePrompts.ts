import { Router } from "express";
import { getPost } from "../services/postStore.js";
import { getAiConfigsForServer } from "../services/configStore.js";
import { createProvider } from "../ai/factory.js";
import { error as logError } from "../services/logger.js";
import {
  buildImagePromptSystemPrompt,
  buildImagePromptUserContent,
  IMAGE_PROMPT_COUNTS,
  IMAGE_PROMPT_EMOTIONAL_LENSES,
  IMAGE_PROMPT_LITERALNESS,
  IMAGE_PROMPT_PEOPLE,
  IMAGE_PROMPT_RELATIONS,
  IMAGE_PROMPT_STYLES,
  type ImagePromptOptions,
} from "../ai/imagePrompts.js";
import { parseJsonCandidates } from "../ai/jsonResponse.js";

export const imagePromptsRouter = Router({ mergeParams: true });

function normalizePromptList(items: unknown): string[] | null {
  if (!Array.isArray(items)) return null;
  const normalized = items
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : null;
}

function parseImagePromptResponse(raw: string): string[] {
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

  throw new Error("Generated image prompts were not valid JSON");
}

imagePromptsRouter.post("/", async (req, res) => {
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

  const options: ImagePromptOptions = {
    count:
      typeof count === "number" && IMAGE_PROMPT_COUNTS.includes(count as (typeof IMAGE_PROMPT_COUNTS)[number])
        ? count
        : 5,
    relation:
      typeof relation === "string" &&
      IMAGE_PROMPT_RELATIONS.includes(relation as (typeof IMAGE_PROMPT_RELATIONS)[number])
        ? (relation as ImagePromptOptions["relation"])
        : "domain",
    emotionalLens:
      typeof emotionalLens === "string" &&
      IMAGE_PROMPT_EMOTIONAL_LENSES.includes(
        emotionalLens as (typeof IMAGE_PROMPT_EMOTIONAL_LENSES)[number]
      )
        ? (emotionalLens as ImagePromptOptions["emotionalLens"])
        : "hopeful",
    literalness:
      typeof literalness === "string" &&
      IMAGE_PROMPT_LITERALNESS.includes(literalness as (typeof IMAGE_PROMPT_LITERALNESS)[number])
        ? (literalness as ImagePromptOptions["literalness"])
        : "stylized",
    people:
      typeof people === "string" &&
      IMAGE_PROMPT_PEOPLE.includes(people as (typeof IMAGE_PROMPT_PEOPLE)[number])
        ? (people as ImagePromptOptions["people"])
        : "mixed",
    style:
      typeof style === "string" &&
      IMAGE_PROMPT_STYLES.includes(style as (typeof IMAGE_PROMPT_STYLES)[number])
        ? (style as ImagePromptOptions["style"])
        : "illustration",
  };

  const postContent = content?.trim() ? content : post.content;

  try {
    const aiConfigs = getAiConfigsForServer(dataDir);
    const activeConfig = aiConfigs.configs.find((c) => c.id === aiConfigs.activeId);
    if (!activeConfig) {
      res.status(503).json({ error: "No active AI configuration selected" });
      return;
    }

    const provider = createProvider(activeConfig);
    const raw = await provider.generateText(
      buildImagePromptSystemPrompt(options.count),
      buildImagePromptUserContent(postContent, options)
    );
    res.json({ items: parseImagePromptResponse(raw) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    logError(`Image prompt generation failed for post ${postId}: ${msg}`);
    res.status(502).json({ error: msg });
  }
});
