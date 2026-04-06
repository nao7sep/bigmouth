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
import { getSettings } from "../services/configStore.js";
import type { PostStatus } from "../shared/types.js";
import * as logger from "../services/logger.js";

export const postsRouter = Router();

/**
 * GET /api/posts
 *
 * Returns all drafts and ready posts (always fully loaded),
 * plus a batch of published posts.
 *
 * Query params:
 *   publishedOffset — offset into published list (default: 0)
 *   limit           — batch size for published (default: from settings, fallback 50)
 */
postsRouter.get("/", (req, res) => {
  const publishedOffset = parseInt(req.query.publishedOffset as string) || 0;
  const limit = parseInt(req.query.limit as string) || getSettings().publishedPostsPerLoad;

  const drafts = listDrafts();
  const ready = listReady();
  const published = listPublished(publishedOffset, limit);
  const publishedTotal = countPublished();

  res.json({
    drafts,
    ready,
    published,
    publishedTotal,
    publishedOffset,
  });
});

/**
 * GET /api/posts/:id
 *
 * Returns a single post with full content.
 */
postsRouter.get("/:id", (req, res) => {
  const post = getPost(req.params.id);
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  res.json({
    frontMatter: post.frontMatter,
    content: post.content,
  });
});

/**
 * POST /api/posts
 *
 * Creates a new draft post.
 * Body: { target: string, language: string }
 */
postsRouter.post("/", (req, res) => {
  const { target, language, sourceId } = req.body;

  if (!target || !language) {
    res.status(400).json({ error: "target and language are required" });
    return;
  }

  const post = createPost(target, language, sourceId);
  logger.info(`Post created: id=${post.frontMatter.id}, target=${target}`);

  res.status(201).json({
    frontMatter: post.frontMatter,
    content: post.content,
  });
});

/**
 * PUT /api/posts/:id
 *
 * Updates a post's content and/or front matter fields.
 * Body: { content?: string, frontMatter?: Partial<PostFrontMatter> }
 */
postsRouter.put("/:id", (req, res) => {
  const { content, frontMatter } = req.body;

  const post = updatePost(req.params.id, { content, frontMatter });
  if (!post) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  res.json({
    frontMatter: post.frontMatter,
    content: post.content,
  });
});

/**
 * PUT /api/posts/:id/status
 *
 * Changes a post's status. Handles file renames and subdirectory moves.
 * Body: { status: "draft" | "ready" | "published" }
 */
postsRouter.put("/:id/status", (req, res) => {
  const { status } = req.body as { status: PostStatus };

  if (!["draft", "ready", "published"].includes(status)) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }

  try {
    const post = changeStatus(req.params.id, status);
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

/**
 * DELETE /api/posts/:id
 *
 * Hard deletes a post and its assets.
 */
postsRouter.delete("/:id", (req, res) => {
  const deleted = deletePost(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  logger.info(`Post deleted: id=${req.params.id}`);
  res.json({ deleted: true });
});
