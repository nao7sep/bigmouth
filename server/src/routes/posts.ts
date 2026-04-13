import { Router } from "express";
import {
  listDrafts,
  listReady,
  listPublished,
  countPublished,
  getPost,
  createPost,
  updatePost,
  changeStatus,
  deletePost,
} from "../services/postStore.js";
import { getSettings, getTargets } from "../services/configStore.js";
import type { PostStatus } from "../shared/types.js";
import * as logger from "../services/logger.js";

export const postsRouter = Router({ mergeParams: true });

postsRouter.get("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const publishedOffset = parseInt(req.query.publishedOffset as string) || 0;
  const limit = parseInt(req.query.limit as string) || getSettings(dataDir).publishedPostsPerLoad;

  const drafts = listDrafts(dataDir);
  const ready = listReady(dataDir);
  const published = listPublished(dataDir, publishedOffset, limit);
  const publishedTotal = countPublished(dataDir);

  res.json({
    drafts,
    ready,
    published,
    publishedTotal,
    publishedOffset,
  });
});

postsRouter.get("/:id", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const post = getPost(dataDir, req.params.id);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  res.json({
    frontMatter: post.frontMatter,
    content: post.content,
  });
});

postsRouter.post("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const { target, language, sourceId } = req.body as {
    target?: unknown;
    language?: unknown;
    sourceId?: unknown;
  };

  if (
    typeof target !== "string" ||
    !target.trim() ||
    typeof language !== "string" ||
    !language.trim()
  ) {
    res.status(400).json({ error: "target and language are required" });
    return;
  }

  if (sourceId !== undefined && typeof sourceId !== "string") {
    res.status(400).json({ error: "sourceId must be a string" });
    return;
  }

  const normalizedTarget = target.trim();
  const normalizedLanguage = language.trim();
  const normalizedSourceId = sourceId?.trim() || undefined;
  const targets = getTargets(dataDir);
  const settings = getSettings(dataDir);

  if (targets.length === 0) {
    res.status(400).json({ error: "No targets configured. Add a target in Settings before creating a post." });
    return;
  }

  if (!targets.some((t) => t.name === normalizedTarget)) {
    res.status(400).json({ error: `Unknown target: ${normalizedTarget}` });
    return;
  }

  if (!settings.supportedLanguages.includes(normalizedLanguage)) {
    res.status(400).json({ error: `Unsupported language: ${normalizedLanguage}` });
    return;
  }

  if (normalizedSourceId && !getPost(dataDir, normalizedSourceId)) {
    res.status(400).json({ error: "Source post not found" });
    return;
  }

  const post = createPost(dataDir, normalizedTarget, normalizedLanguage, normalizedSourceId);
  logger.info(`Post created: id=${post.frontMatter.id}, target=${normalizedTarget}`);

  res.status(201).json({
    frontMatter: post.frontMatter,
    content: post.content,
  });
});

postsRouter.put("/:id", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const { content, frontMatter } = req.body;

  const post = updatePost(dataDir, req.params.id, { content, frontMatter });
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  res.json({
    frontMatter: post.frontMatter,
    content: post.content,
  });
});

postsRouter.put("/:id/status", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const { status } = req.body as { status: PostStatus };

  if (!["draft", "ready", "published"].includes(status)) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }

  try {
    const post = changeStatus(dataDir, req.params.id, status);
    if (!post) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    logger.info(
      `Post status changed: id=${req.params.id}, status=${status}`
    );

    res.json({
      frontMatter: post.frontMatter,
      content: post.content,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(400).json({ error: message });
  }
});

postsRouter.delete("/:id", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const deleted = deletePost(dataDir, req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  logger.info(`Post deleted: id=${req.params.id}`);
  res.json({ deleted: true });
});
