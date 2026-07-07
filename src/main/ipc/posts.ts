import { ipcMain } from "electron";

import { CHANNELS, type PostUpdate } from "@shared/ipc";
import type { PostStatus } from "@shared/types";
import {
  listDrafts,
  listReady,
  listPublished,
  countPublished,
  listExpired,
  countExpired,
  getPost,
  createPost,
  updatePost,
  changeStatus,
  deletePost,
  rebuildIndex,
  postExists,
  listReferrers,
  getPostSummary,
} from "../core/services/postStore.js";
import { getSettings, getTargets } from "../core/services/configStore.js";
import { validatePostUpdate } from "../core/shared/postUpdate.js";
import { presentString, safePostLogContext } from "../core/shared/logSummaries.js";
import { info, warn, error as logError, serializeError } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

const STATUSES: PostStatus[] = ["draft", "ready", "published", "expired"];

export function registerPostHandlers(): void {
  ipcMain.handle(CHANNELS.listPosts, (_event, wsId: string, publishedOffset: number, limit: number, expiredOffset: number) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    // Clamp to >= 0: a negative offset would slice from the end of the list.
    const pOff = Math.max(0, publishedOffset || 0);
    const eOff = Math.max(0, expiredOffset || 0);
    const lim = limit || getSettings(dir).publishedPostsPerLoad;

    const drafts = listDrafts(dir);
    const ready = listReady(dir);
    const published = listPublished(dir, pOff, lim);
    const publishedTotal = countPublished(dir);
    const expired = listExpired(dir, eOff, lim);
    const expiredTotal = countExpired(dir);

    info("posts listed", {
      workspace: wsId,
      drafts: drafts.length,
      ready: ready.length,
      publishedReturned: published.length,
      publishedTotal,
      expiredReturned: expired.length,
      expiredTotal,
      limit: lim,
    });

    return {
      drafts,
      ready,
      published,
      publishedTotal,
      publishedOffset: pOff,
      expired,
      expiredTotal,
      expiredOffset: eOff,
    };
  });

  ipcMain.handle(CHANNELS.rebuildPostIndex, (_event, wsId: string) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    let count: number;
    try {
      count = rebuildIndex(dir);
    } catch (err) {
      logError("post index rebuild failed", { workspace: wsId, error: serializeError(err) });
      throw err instanceof Error ? err : new Error("Index rebuild failed");
    }
    info("post index rebuilt", { workspace: wsId, count });
    return { count };
  });

  ipcMain.handle(CHANNELS.getPost, (_event, wsId: string, id: string) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    const post = getPost(dir, id);
    if (!post) {
      warn("post lookup failed", { workspace: wsId, postId: id, reason: "not-found" });
      throw new Error("Post not found");
    }
    info("post loaded", {
      workspace: wsId,
      postId: post.frontMatter.id,
      status: post.frontMatter.status,
      contentLength: post.content.length,
    });
    return { frontMatter: post.frontMatter, content: post.content };
  });

  ipcMain.handle(CHANNELS.listReferrers, (_event, wsId: string, id: string) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    const ids = listReferrers(dir, id);
    return { count: ids.length, ids };
  });

  ipcMain.handle(CHANNELS.createPost, (_event, wsId: string, target: string, language: string, sourceId?: string) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    if (typeof target !== "string" || !target.trim() || typeof language !== "string" || !language.trim()) {
      throw new Error("target and language are required");
    }
    if (sourceId !== undefined && typeof sourceId !== "string") {
      throw new Error("sourceId must be a string");
    }

    const normalizedTarget = target.trim();
    const normalizedLanguage = language.trim();
    const normalizedSourceId = sourceId?.trim() || undefined;
    const targets = getTargets(dir);
    const settings = getSettings(dir);

    if (targets.length === 0) {
      throw new Error("No targets configured. Add a target in Settings before creating a post.");
    }
    if (!targets.some((t) => t.name === normalizedTarget)) {
      throw new Error(`Unknown target: ${normalizedTarget}`);
    }
    if (!settings.supportedLanguages.includes(normalizedLanguage)) {
      throw new Error(`Unsupported language: ${normalizedLanguage}`);
    }
    if (normalizedSourceId && !postExists(dir, normalizedSourceId)) {
      throw new Error("Source post not found");
    }

    const post = createPost(dir, normalizedTarget, normalizedLanguage, normalizedSourceId);
    info("post created", {
      workspace: wsId,
      postId: post.frontMatter.id,
      target: normalizedTarget,
      language: normalizedLanguage,
      sourceId: normalizedSourceId ?? null,
    });
    return { frontMatter: post.frontMatter, content: post.content };
  });

  ipcMain.handle(CHANNELS.updatePost, (_event, wsId: string, id: string, updates: PostUpdate) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    const content = updates?.content;
    const existing = getPost(dir, id);
    if (!existing) {
      throw new Error("Post not found");
    }

    const validation = validatePostUpdate(existing.frontMatter, updates);
    if (!validation.ok) {
      warn("post update rejected", {
        workspace: wsId,
        postId: id,
        reason: validation.reason,
        ...(validation.reservedKeys ? { reservedKeys: validation.reservedKeys } : {}),
      });
      throw new Error(validation.message);
    }

    const edits = validation.edits;

    // The only edit check that needs the filesystem: a referenced source post
    // must exist. The self-source rule is decided purely in validatePostUpdate.
    if (typeof edits.sourceId === "string" && edits.sourceId && !postExists(dir, edits.sourceId)) {
      throw new Error("Source post not found");
    }

    const oldSlug = presentString(existing.frontMatter.slug);
    const oldFilePath = existing.filePath;
    const post = updatePost(dir, id, { content, frontMatter: edits });
    if (!post) {
      warn("post update failed", { workspace: wsId, postId: id, reason: "not-found-after-update" });
      throw new Error("Post not found");
    }

    const newSlug = presentString(post.frontMatter.slug);
    info("post updated", {
      workspace: wsId,
      postId: post.frontMatter.id,
      contentUpdated: content !== undefined,
      frontMatterKeys: Object.keys(edits),
      slugChanged: oldSlug !== newSlug,
      fileChanged: oldFilePath !== post.filePath,
      before: safePostLogContext(existing),
      after: safePostLogContext(post),
    });

    // Include the canonical list summary so the renderer's optimistic update uses
    // the authoritative projection (with its derived excerpt).
    return {
      frontMatter: post.frontMatter,
      content: post.content,
      summary: getPostSummary(dir, post.frontMatter.id),
    };
  });

  ipcMain.handle(CHANNELS.changePostStatus, (_event, wsId: string, id: string, status: PostStatus) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    if (!STATUSES.includes(status)) {
      throw new Error("Invalid status");
    }
    const before = getPost(dir, id);
    if (!before) {
      warn("post status change failed", { workspace: wsId, postId: id, requestedStatus: status, reason: "not-found" });
      throw new Error("Post not found");
    }
    try {
      const post = changeStatus(dir, id, status);
      if (!post) {
        throw new Error("Post not found");
      }
      info("post status changed", {
        workspace: wsId,
        postId: id,
        requestedStatus: status,
        statusBefore: before.frontMatter.status,
        statusAfter: post.frontMatter.status,
        fileChanged: before.filePath !== post.filePath,
        before: safePostLogContext(before),
        after: safePostLogContext(post),
      });
      return {
        frontMatter: post.frontMatter,
        content: post.content,
        summary: getPostSummary(dir, post.frontMatter.id),
      };
    } catch (err) {
      logError("post status change failed", {
        workspace: wsId,
        postId: id,
        statusBefore: before.frontMatter.status,
        requestedStatus: status,
        error: serializeError(err),
      });
      throw err instanceof Error ? err : new Error("Unknown error");
    }
  });

  ipcMain.handle(CHANNELS.deletePost, (_event, wsId: string, id: string) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    const deleted = deletePost(dir, id);
    if (!deleted) {
      warn("post delete failed", { workspace: wsId, postId: id, reason: "not-found" });
      throw new Error("Post not found");
    }
    info("post deleted", { workspace: wsId, postId: id });
  });
}
