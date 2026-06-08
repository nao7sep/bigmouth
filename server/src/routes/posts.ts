import { Router } from "express";
import {
  listDrafts,
  listChecked,
  listPublished,
  countPublished,
  getPost,
  createPost,
  updatePost,
  changeStatus,
  deletePost,
  rebuildIndex,
  postExists,
  listReferrers,
  getPostSummary,
} from "../services/postStore.js";
import { getSettings, getTargets } from "../services/configStore.js";
import type { PostStatus, EditablePostMetadata } from "../shared/types.js";
import { presentString, safePostLogContext } from "../shared/logSummaries.js";
import * as logger from "../services/logger.js";

export const postsRouter = Router({ mergeParams: true });

// Slug must be safe for use in export filenames and URLs: ASCII alphanumerics,
// hyphens, and underscores only.
const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

// Front matter fields a client may set through PUT /:id. Identity and lifecycle
// fields are excluded — they move only through createPost and the status route.
const EDITABLE_FRONT_MATTER_KEYS = [
  "target",
  "language",
  "title",
  "titleEn",
  "slug",
  "tags",
  "tagsEn",
  "metaDescription",
  "metaDescriptionEn",
  "extra",
  "sourceId",
] as const;

const RESERVED_FRONT_MATTER_KEYS = new Set([
  "id",
  "status",
  "createdAtUtc",
  "updatedAtUtc",
  "checkedAtUtc",
  "publishedAtUtc",
]);

const STATUSES: PostStatus[] = ["draft", "checked", "published"];

function validateSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return SLUG_RE.test(value) ? value : null;
}

postsRouter.get("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const publishedOffset = parseInt(req.query.publishedOffset as string) || 0;
  const limit = parseInt(req.query.limit as string) || getSettings(dataDir).publishedPostsPerLoad;

  const drafts = listDrafts(dataDir);
  const checked = listChecked(dataDir);
  const published = listPublished(dataDir, publishedOffset, limit);
  const publishedTotal = countPublished(dataDir);

  logger.info(
    `Posts listed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, drafts=${drafts.length}, checked=${checked.length}, publishedReturned=${published.length}, publishedTotal=${publishedTotal}, publishedOffset=${publishedOffset}, limit=${limit}`
  );

  res.json({
    drafts,
    checked,
    published,
    publishedTotal,
    publishedOffset,
  });
});

// Rebuild the derived index from the Markdown files (the source of truth).
// Declared before "/:id" so the static path is not captured as an id.
postsRouter.post("/index/rebuild", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  let count: number;
  try {
    count = rebuildIndex(dataDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Index rebuild failed";
    logger.error(
      `Post index rebuild failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, message=${message}`
    );
    res.status(500).json({ error: message });
    return;
  }
  logger.info(
    `Post index rebuilt: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, count=${count}`
  );
  res.json({ rebuilt: true, count });
});

postsRouter.get("/:id", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const post = getPost(dataDir, req.params.id);
  if (!post) {
    logger.warn(
      `Post lookup failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${req.params.id}, reason=not-found`
    );
    res.status(404).json({ error: "Post not found" });
    return;
  }

  logger.info(
    `Post loaded: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${post.frontMatter.id}, status=${post.frontMatter.status}, contentLength=${post.content.length}`
  );

  res.json({
    frontMatter: post.frontMatter,
    content: post.content,
  });
});

// Posts that link this one as their source. Used to warn before deleting (the
// links are cleared on delete) and to surface the relationship in the UI.
postsRouter.get("/:id/referrers", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const ids = listReferrers(dataDir, req.params.id);
  res.json({ count: ids.length, ids });
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

  if (normalizedSourceId && !postExists(dataDir, normalizedSourceId)) {
    res.status(400).json({ error: "Source post not found" });
    return;
  }

  const post = createPost(dataDir, normalizedTarget, normalizedLanguage, normalizedSourceId);
  logger.info(
    `Post created: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, id=${post.frontMatter.id}, target=${normalizedTarget}, language=${normalizedLanguage}, sourceId=${normalizedSourceId ?? "-"}`
  );

  res.status(201).json({
    frontMatter: post.frontMatter,
    content: post.content,
  });
});

postsRouter.put("/:id", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const { content, frontMatter } = req.body ?? {};
  const existing = getPost(dataDir, req.params.id);

  if (!existing) {
    res.status(404).json({ error: "Post not found" });
    return;
  }

  // Published posts are locked. Editing happens only after moving back to Draft
  // or Checked, so the autosaving editor can never silently mutate a published
  // post.
  if (existing.frontMatter.status === "published") {
    logger.warn(
      `Post update rejected: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${req.params.id}, reason=published-locked`
    );
    res.status(409).json({ error: "Published posts are locked. Move the post back to Checked or Draft to edit it." });
    return;
  }

  if (frontMatter !== undefined && (!frontMatter || typeof frontMatter !== "object" || Array.isArray(frontMatter))) {
    res.status(400).json({ error: "frontMatter must be an object" });
    return;
  }

  const reservedKeys = Object.keys(frontMatter ?? {}).filter((key) =>
    RESERVED_FRONT_MATTER_KEYS.has(key)
  );
  if (reservedKeys.length > 0) {
    logger.warn(
      `Post update rejected: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${req.params.id}, reason=reserved-front-matter, reservedKeys=${reservedKeys.join(",")}`
    );
    res.status(400).json({
      error: `Reserved front matter fields cannot be updated here: ${reservedKeys.join(", ")}`,
    });
    return;
  }

  // Slug is part of export filenames and URLs — reject anything unsafe.
  if (frontMatter && Object.prototype.hasOwnProperty.call(frontMatter, "slug")) {
    const slug = frontMatter.slug;
    if (slug !== null && slug !== undefined && slug !== "") {
      if (!validateSlug(slug)) {
        logger.warn(
          `Post update rejected: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${req.params.id}, reason=invalid-slug`
        );
        res.status(400).json({ error: "Invalid slug: only letters, digits, hyphens, and underscores are allowed" });
        return;
      }
    }
  }

  const edits = pickEditableFrontMatter(frontMatter);

  // A source link must point at a real, different post (mirrors the create route).
  if (typeof edits.sourceId === "string" && edits.sourceId) {
    if (edits.sourceId === req.params.id) {
      res.status(400).json({ error: "A post cannot be its own source" });
      return;
    }
    if (!postExists(dataDir, edits.sourceId)) {
      res.status(400).json({ error: "Source post not found" });
      return;
    }
  }

  const oldSlug = presentString(existing.frontMatter.slug);
  const oldFilePath = existing.filePath;
  const post = updatePost(dataDir, req.params.id, { content, frontMatter: edits });
  if (!post) {
    logger.warn(
      `Post update failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${req.params.id}, reason=not-found-after-update`
    );
    res.status(404).json({ error: "Post not found" });
    return;
  }

  const newSlug = presentString(post.frontMatter.slug);
  const updateDetails = {
    contentUpdated: content !== undefined,
    contentLengthBefore: existing.content.length,
    contentLengthAfter: post.content.length,
    frontMatterKeys: Object.keys(edits),
    slugBefore: oldSlug,
    slugAfter: newSlug,
    slugChanged: oldSlug !== newSlug,
    fileChanged: oldFilePath !== post.filePath,
    before: safePostLogContext(existing),
    after: safePostLogContext(post),
  };
  logger.info(
    `Post updated: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${post.frontMatter.id}, details=${logger.formatLogValue(updateDetails)}`
  );

  // Include the canonical list summary so the client's optimistic update uses
  // the authoritative projection (with its derived excerpt) instead of rebuilding one.
  res.json({
    frontMatter: post.frontMatter,
    content: post.content,
    summary: getPostSummary(dataDir, post.frontMatter.id),
  });
});

postsRouter.put("/:id/status", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const { status } = req.body as { status: PostStatus };

  if (!STATUSES.includes(status)) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }

  const before = getPost(dataDir, req.params.id);
  if (!before) {
    logger.warn(
      `Post status change failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, id=${req.params.id}, requestedStatus=${status}, reason=not-found`
    );
    res.status(404).json({ error: "Post not found" });
    return;
  }

  try {
    const post = changeStatus(dataDir, req.params.id, status);
    if (!post) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    const statusDetails = {
      requestedStatus: status,
      statusBefore: before.frontMatter.status,
      statusAfter: post.frontMatter.status,
      slug: presentString(post.frontMatter.slug),
      fileChanged: before.filePath !== post.filePath,
      checkedAtUtcBefore: presentString(before.frontMatter.checkedAtUtc),
      checkedAtUtcAfter: presentString(post.frontMatter.checkedAtUtc),
      publishedAtUtcBefore: presentString(before.frontMatter.publishedAtUtc),
      publishedAtUtcAfter: presentString(post.frontMatter.publishedAtUtc),
      before: safePostLogContext(before),
      after: safePostLogContext(post),
    };
    logger.info(
      `Post status changed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, id=${req.params.id}, details=${logger.formatLogValue(statusDetails)}`
    );

    res.json({
      frontMatter: post.frontMatter,
      content: post.content,
      summary: getPostSummary(dataDir, post.frontMatter.id),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(
      `Post status change failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, id=${req.params.id}, statusBefore=${before.frontMatter.status}, requestedStatus=${status}, slug=${presentString(before.frontMatter.slug)}, message=${message}`
    );
    res.status(400).json({ error: message });
  }
});

postsRouter.delete("/:id", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const deleted = deletePost(dataDir, req.params.id);
  if (!deleted) {
    logger.warn(
      `Post delete failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, postId=${req.params.id}, reason=not-found`
    );
    res.status(404).json({ error: "Post not found" });
    return;
  }

  logger.info(
    `Post deleted: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, id=${req.params.id}`
  );
  res.json({ deleted: true });
});

/**
 * Copies only the editable front matter keys from a request body. Reserved keys
 * are rejected earlier; unknown keys are ignored so a PUT can never invent
 * front matter.
 */
function pickEditableFrontMatter(frontMatter: unknown): EditablePostMetadata {
  const edits: EditablePostMetadata = {};
  if (!frontMatter || typeof frontMatter !== "object") return edits;
  const source = frontMatter as Record<string, unknown>;
  for (const key of EDITABLE_FRONT_MATTER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      (edits as Record<string, unknown>)[key] = source[key];
    }
  }
  return edits;
}
