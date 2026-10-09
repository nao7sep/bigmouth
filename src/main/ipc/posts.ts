import { BrowserWindow, ipcMain } from "electron";

import {
  CHANNELS,
  type PostContentSavedEvent,
  type PostContentSaveFailedEvent,
  type PostMetadataRefusedEvent,
  type PostUpdate,
} from "@shared/ipc";
import type { EditablePostMetadata, PostListResponse, PostStatus } from "@shared/types";
import {
  refreshIndex,
  listByStatus,
  countByStatus,
  getPost,
  createPost,
  updatePost,
  changeStatus,
  setLocked,
  deletePost,
  rebuildIndex,
  postExists,
  listReferrers,
  getPostSummary,
  queueWorkspaceContent,
  queueWorkspaceMetadata,
  setContentSaveListener,
  setHeldEditFailureListener,
  holdsContentFor,
} from "../storageAccess.js";
import { EditPendingError } from "../storageOwner.js";
import type { RebuildResult } from "../core/services/postIndex.js";
import { getSettings, getTargets } from "../storageAccess.js";
import { validatePostUpdate } from "../core/shared/postUpdate.js";
import { POST_STATUSES, isPostStatus } from "../core/shared/postLifecycle.js";
import { isPagedPostStatus } from "@shared/postStatus";
import { debug as logDebug, info, warn, error as logError, serializeError } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";
import { message, type Message } from "@shared/i18n/translate";




/** Sends a main -> renderer event to every live window. */
function broadcast(channel: string, payload: PostContentSavedEvent | PostContentSaveFailedEvent | PostMetadataRefusedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export function registerPostHandlers(): void {
  // The write-behind buffer's save events, broadcast to every window. Post ids
  // are unique nanoids, so the renderer matches by post id alone.
  setContentSaveListener((event) => {
    if (event.kind === "saved") {
      // Text held behind this save, waiting for storage, is newer than what
      // was written, so the post must keep showing that it is not saved yet.
      const saved: PostContentSavedEvent = { postId: event.id, summary: event.summary, newerEditHeld: holdsContentFor(event.id) };
      broadcast(CHANNELS.postContentSaved, saved);
      return;
    }
    // Every failure rides the one failure channel, told apart by `kind`: a
    // write failure is retried from the buffer, while a missing post and a
    // locked one never can be.
    const failure: PostContentSaveFailedEvent = {
      postId: event.id,
      kind: event.kind === "save-failed" ? "retrying" : "unsaveable",
    };
    logError("post content save failed", {
      postId: failure.postId,
      kind: failure.kind,
      reason: event.kind,
      ...(event.kind === "save-failed" ? { message: event.message, error: serializeError(event.error) } : {}),
    });
    broadcast(CHANNELS.postContentSaveFailed, failure);
  });

  // An edit storage could not take yet is held by the storage owner and
  // delivered when storage takes work again; until a save event arrives the
  // post shows the retrying state, the same as a write that will be retried.
  const reportHeld = (id: string) => {
    const pending: PostContentSaveFailedEvent = { postId: id, kind: "retrying" };
    broadcast(CHANNELS.postContentSaveFailed, pending);
  };

  // A held edit that failed once delivered. Its caller was answered when it
  // was held, so the failure is reported here instead: an edit storage could
  // not take is unsaveable text, and a metadata value the store refused goes
  // back to its field, which then shows why and makes quit ask before it is lost.
  setHeldEditFailureListener((request, failure) => {
    const id = String(request.args[1]);
    logError("held post edit failed on delivery", {
      postId: id,
      command: request.name,
      ...(failure instanceof Error ? { error: serializeError(failure) } : { refusal: failure }),
    });
    if (failure instanceof Error) {
      const unsaveable: PostContentSaveFailedEvent = { postId: id, kind: "unsaveable" };
      broadcast(CHANNELS.postContentSaveFailed, unsaveable);
      return;
    }
    const refused: PostMetadataRefusedEvent = {
      postId: id,
      edits: request.args[2] as EditablePostMetadata,
      refusal: failure as Message,
    };
    broadcast(CHANNELS.postMetadataRefused, refused);
  });

  // One-way: buffer a content edit. Never throws back to the renderer — the
  // channel is fire-and-forget, and failures surface through the save events.
  // A workspace that no longer resolves is one of those failures: the text
  // never reached the buffer, so it is reported on the same channel instead of
  // being logged away while the editor still looks saved.
  ipcMain.on(CHANNELS.queuePostContent, async (_event, wsId: string, id: string, content: string) => {
    if (typeof wsId !== "string" || typeof id !== "string" || typeof content !== "string") return;
    try {
      const pending = queueWorkspaceContent(wsId, id, content);
      // Per keystroke, so `debug` by the logging conventions' frequency rule —
      // never on a user's disk, and exactly the trail wanted when chasing a save
      // that did not land.
      logDebug("post content queued", { workspace: wsId, postId: id, length: content.length });
      await pending;
    } catch (err) {
      if (err instanceof EditPendingError) {
        reportHeld(id);
        return;
      }
      logError("post content queue failed", { workspace: wsId, postId: id, error: serializeError(err) });
      const failure: PostContentSaveFailedEvent = { postId: id, kind: "unsaveable" };
      broadcast(CHANNELS.postContentSaveFailed, failure);
    }
  });

  // Buffer a metadata field edit, as content is buffered. Checked against the
  // index row, never the post file, because it runs per keystroke. The reply is
  // the refusal (null when buffered) so the field can say why it will not save;
  // save outcomes after that ride the same events as content.
  ipcMain.handle(CHANNELS.queuePostMetadata, async (_event, wsId: string, id: string, edits: unknown) => {
    if (typeof wsId !== "string" || typeof id !== "string") return message("metadata.refusedInvalid");
    try {
      return await queueWorkspaceMetadata(wsId, id, edits);
    } catch (err) {
      if (!(err instanceof EditPendingError)) throw err;
      reportHeld(id);
      return null;
    }
  });

  ipcMain.handle(CHANNELS.listPosts, async (_event, wsId: string, offsets: unknown, limit: number) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const lim = limit || (await getSettings(dir)).postsPerLoad;

    const unreadable = (await refreshIndex(dir));
    const response = {} as PostListResponse;
    if (unreadable.length > 0) response.unreadable = unreadable;
    for (const status of POST_STATUSES) {
      if (!isPagedPostStatus(status)) {
        const posts = (await listByStatus(dir, status));
        response[status] = { posts, total: posts.length, offset: 0 };
        continue;
      }
      // Clamp to >= 0: a negative offset would slice from the end of the list.
      const requested = (offsets as Partial<Record<string, unknown>> | null)?.[status];
      const offset = typeof requested === "number" ? Math.max(0, requested) : 0;
      response[status] = {
        posts: (await listByStatus(dir, status, { offset, limit: lim })),
        total: (await countByStatus(dir, status)),
        offset,
      };
    }

    info("posts listed", {
      workspace: wsId,
      limit: lim,
      ...Object.fromEntries(
        POST_STATUSES.map((status) => [status, { returned: response[status].posts.length, total: response[status].total }]),
      ),
    });

    return response;
  });

  ipcMain.handle(CHANNELS.rebuildPostIndex, async (_event, wsId: string) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    let result: RebuildResult & { orphanedAssets: number };
    try {
      result = (await rebuildIndex(dir));
    } catch (err) {
      logError("post index rebuild failed", { workspace: wsId, error: serializeError(err) });
      throw err instanceof Error ? err : new Error("Index rebuild failed");
    }
    // Every skipped file is named in the log, and the count of them goes back to
    // the caller: a rebuild that reported only what it indexed let a post the
    // user had hand-edited into something unreadable vanish under a success
    // message.
    info("post index rebuilt", {
      workspace: wsId,
      indexed: result.indexed,
      skipped: result.skipped,
      duplicateSlugs: result.duplicateSlugs,
      orphanedAssets: result.orphanedAssets,
    });
    return {
      count: result.indexed,
      skipped: result.skipped.length,
      duplicateSlugs: result.duplicateSlugs.length,
      orphanedAssets: result.orphanedAssets,
    };
  });

  ipcMain.handle(CHANNELS.getPost, async (_event, wsId: string, id: string) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const post = (await getPost(dir, id));
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

  ipcMain.handle(CHANNELS.listReferrers, async (_event, wsId: string, id: string) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const ids = (await listReferrers(dir, id));
    return { count: ids.length, ids };
  });

  ipcMain.handle(CHANNELS.createPost, async (_event, wsId: string, target: string, language: string, sourceId?: string) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    if (typeof target !== "string" || !target.trim() || typeof language !== "string" || !language.trim()) {
      throw new Error("target and language are required");
    }
    if (sourceId !== undefined && typeof sourceId !== "string") {
      throw new Error("sourceId must be a string");
    }

    const normalizedTarget = target.trim();
    const normalizedLanguage = language.trim();
    const normalizedSourceId = sourceId?.trim() || undefined;
    const targets = (await getTargets(dir));
    const settings = (await getSettings(dir));

    if (targets.length === 0) {
      throw new Error("No targets configured. Add a target in Settings before creating a post.");
    }
    if (!targets.some((t) => t.name === normalizedTarget)) {
      throw new Error(`Unknown target: ${normalizedTarget}`);
    }
    if (!settings.supportedLanguages.includes(normalizedLanguage)) {
      throw new Error(`Unsupported language: ${normalizedLanguage}`);
    }
    if (normalizedSourceId && !(await postExists(dir, normalizedSourceId))) {
      throw new Error("Source post not found");
    }

    const post = (await createPost(dir, normalizedTarget, normalizedLanguage, normalizedSourceId));
    info("post created", {
      workspace: wsId,
      postId: post.frontMatter.id,
      target: normalizedTarget,
      language: normalizedLanguage,
      sourceId: normalizedSourceId ?? null,
    });
    return { frontMatter: post.frontMatter, content: post.content };
  });

  ipcMain.handle(CHANNELS.updatePost, async (_event, wsId: string, id: string, updates: PostUpdate) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const content = updates?.content;
    const existing = (await getPost(dir, id));
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
    if (typeof edits.sourceId === "string" && edits.sourceId && !(await postExists(dir, edits.sourceId))) {
      throw new Error("Source post not found");
    }

    const oldSlug = existing.frontMatter.slug?.trim() ?? "";
    const oldFilePath = existing.filePath;
    const post = (await updatePost(dir, id, { content, frontMatter: edits }));
    if (!post) {
      warn("post update failed", { workspace: wsId, postId: id, reason: "not-found-after-update" });
      throw new Error("Post not found");
    }

    const newSlug = post.frontMatter.slug?.trim() ?? "";
    info("post updated", {
      workspace: wsId,
      postId: post.frontMatter.id,
      contentUpdated: content !== undefined,
      frontMatterKeys: Object.keys(edits),
      slugChanged: oldSlug !== newSlug,
      fileChanged: oldFilePath !== post.filePath,
      before: existing.frontMatter,
      after: post.frontMatter,
    });

    // Include the canonical list summary so the renderer's optimistic update uses
    // the authoritative projection (with its derived excerpt).
    return {
      frontMatter: post.frontMatter,
      content: post.content,
      summary: (await getPostSummary(dir, post.frontMatter.id)),
    };
  });

  ipcMain.handle(CHANNELS.changePostStatus, async (_event, wsId: string, id: string, status: PostStatus) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    if (!isPostStatus(status)) {
      throw new Error("Invalid status");
    }
    const before = (await getPost(dir, id));
    if (!before) {
      warn("post status change failed", { workspace: wsId, postId: id, requestedStatus: status, reason: "not-found" });
      throw new Error("Post not found");
    }
    try {
      const post = (await changeStatus(dir, id, status));
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
        before: before.frontMatter,
        after: post.frontMatter,
      });
      return {
        frontMatter: post.frontMatter,
        content: post.content,
        summary: (await getPostSummary(dir, post.frontMatter.id)),
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

  // Locking is not an edit: it changes no time, and it is allowed whatever the
  // post's status. Locking writes the post's buffered edits first.
  ipcMain.handle(CHANNELS.setPostLocked, async (_event, wsId: string, id: string, locked: unknown) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    if (typeof locked !== "boolean") {
      throw new Error("locked must be a boolean");
    }
    const post = (await setLocked(dir, id, locked));
    if (!post) {
      warn("post lock change failed", { workspace: wsId, postId: id, locked, reason: "not-found" });
      throw new Error("Post not found");
    }
    info("post lock changed", { workspace: wsId, postId: id, locked });
    return {
      frontMatter: post.frontMatter,
      content: post.content,
      summary: (await getPostSummary(dir, post.frontMatter.id)),
    };
  });

  ipcMain.handle(CHANNELS.deletePost, async (_event, wsId: string, id: string) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const deleted = (await deletePost(dir, id));
    if (!deleted) {
      warn("post delete failed", { workspace: wsId, postId: id, reason: "not-found" });
      throw new Error("Post not found");
    }
    info("post deleted", { workspace: wsId, postId: id });
  });
}
