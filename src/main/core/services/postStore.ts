/**
 * Post store: the create/read/update/status/delete/list API over post files.
 *
 * Posts live in a single `posts/` directory; each file's name is fixed for its
 * lifetime, so a status change or edit rewrites the file in place rather than
 * moving it. Every mutation writes the `.md` file (the source of truth) and
 * then updates the derived index. Listing reads from the index alone — no post
 * bodies are read to render a list, so the published archive stays cheap.
 *
 * Edits stream through a write-behind buffer owned by this store: the renderer
 * sends every editor change via queueContent and every metadata field edit via
 * queueMetadata, the store coalesces them into one disk write per debounce
 * window, and getPost overlays the pending content and metadata so every
 * reader — status changes, AI calls, export — always sees the newest edit
 * without knowing the buffer exists. Because updatePost and changeStatus read
 * through getPost, any full write persists the pending edits as a side effect
 * and clears the buffer. The main process therefore never depends on the
 * renderer to flush: quit calls flushAllPendingEdits and the newest keystroke,
 * in the editor or a metadata field, is on disk.
 *
 * The rule the buffer is built on: the store never reports success for text it
 * did not persist. Text that is not on disk is either retried (a failed write)
 * or reported as terminal (the post is gone from the index, so no retry can
 * land) — and in both cases the buffer is kept, never discarded.
 */

import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type {
  Post,
  PostFrontMatter,
  PostIndexEntry,
  PostSummary,
  PostStatus,
  EditablePostMetadata,
} from "../shared/types.js";
import { utcNow, formatUtcIso } from "../shared/timestamps.js";
import { byCreatedDesc, byExpiredDesc, byPublishedDesc } from "@shared/postOrder";
import { postFileName } from "../shared/filenames.js";
import { readPost, writePost, projectIndexEntry } from "./postFile.js";
import { applyStatusTransition, isEditLocked } from "../shared/postLifecycle.js";
import * as index from "./postIndex.js";
import { assetDir } from "./assetStore.js";
import { serializeError, warn as logWarn } from "./logger.js";

export function clearCache(dataDir: string): void {
  index.clearCache(dataDir);
}

/**
 * Rebuilds the index, and counts asset folders whose post no longer exists.
 *
 * deletePost removes a post's assets with it, but a `.md` deleted outside the
 * app leaves `assets/<id>/` behind with nothing in the UI that can reach it —
 * unlistable, unopenable, and invisible. Nothing here deletes them: they are the
 * user's uploads, and a `.md` can be deleted by accident or restored from git.
 * Saying how many there are, after a rebuild the user asked for, is the path to
 * them that did not exist.
 */
export function rebuildIndex(dataDir: string): index.RebuildResult & { orphanedAssets: number } {
  const result = index.rebuild(dataDir);
  return { ...result, orphanedAssets: countOrphanedAssetDirs(dataDir) };
}

function countOrphanedAssetDirs(dataDir: string): number {
  const assetsRoot = path.join(dataDir, "assets");
  if (!fs.existsSync(assetsRoot)) return 0;

  let orphans = 0;
  for (const name of fs.readdirSync(assetsRoot)) {
    if (name.startsWith(".")) continue;
    if (!fs.statSync(path.join(assetsRoot, name)).isDirectory()) continue;
    if (!index.getEntry(dataDir, name)) orphans++;
  }
  return orphans;
}

function postsDir(dataDir: string): string {
  return path.join(dataDir, "posts");
}

function filePathFor(dataDir: string, entry: PostIndexEntry): string {
  return path.join(postsDir(dataDir), entry.fileName);
}

// --- Pending edits (write-behind buffer) ---

const PENDING_FLUSH_DELAY_MS = 750;
const PENDING_RETRY_DELAY_MS = 5000;

/**
 * One post's newest edits not yet on disk: its content, when the editor changed
 * it, and the metadata fields changed since the last write.
 *
 * `terminal` is why no write from this path can land — the post is gone from
 * the index, or it is locked — and null while the edit is still savable. The
 * text is kept either way (it is the user's work), but a terminal edit is never
 * scheduled, and setting the reason is also what makes the failure announce
 * once rather than on every keystroke.
 */
interface PendingEdit {
  content?: string;
  frontMatter: EditablePostMetadata;
  terminal: string | null;
}

const POST_MISSING_REASON = "post file is missing";

function lockedReason(status: PostStatus): string {
  return `post is ${status} and locked`;
}

// dataDir -> post id -> newest edits not yet on disk.
const pendingEdits = new Map<string, Map<string, PendingEdit>>();
const pendingTimers = new Map<string, Map<string, NodeJS.Timeout>>();

/**
 * What became of a buffered edit. Retryable and terminal are deliberately
 * distinct: `save-failed` is retryable (the same write can land later), while
 * `post-missing` and `locked` are terminal — no retry can bring a deleted file
 * back or unlock a published post, so folding either into the retry loop would
 * spin forever. None is ever silent.
 */
export type ContentSaveEvent =
  | { kind: "saved"; dataDir: string; id: string; summary: PostIndexEntry }
  | { kind: "save-failed"; dataDir: string; id: string; message: string; error: unknown }
  | { kind: "post-missing"; dataDir: string; id: string }
  | { kind: "locked"; dataDir: string; id: string; status: PostStatus };

// Single subscriber (the IPC layer), which broadcasts to windows. The store
// stays free of Electron types.
let contentSaveListener: ((event: ContentSaveEvent) => void) | null = null;

export function setContentSaveListener(listener: ((event: ContentSaveEvent) => void) | null): void {
  contentSaveListener = listener;
}

function getPending(dataDir: string, id: string): PendingEdit | undefined {
  return pendingEdits.get(dataDir)?.get(id);
}

function pendingFor(dataDir: string, id: string): PendingEdit {
  let posts = pendingEdits.get(dataDir);
  if (!posts) {
    posts = new Map();
    pendingEdits.set(dataDir, posts);
  }
  let pending = posts.get(id);
  if (!pending) {
    pending = { frontMatter: {}, terminal: null };
    posts.set(id, pending);
  }
  return pending;
}

function cancelFlush(dataDir: string, id: string): void {
  const timers = pendingTimers.get(dataDir);
  const timer = timers?.get(id);
  if (timer) {
    clearTimeout(timer);
    timers?.delete(id);
  }
}

function clearPending(dataDir: string, id: string): void {
  pendingEdits.get(dataDir)?.delete(id);
  cancelFlush(dataDir, id);
}

/**
 * A terminal outcome: no write from this path can land — the post is no longer
 * in the index, or it is locked. The buffered text stays (it is the user's
 * work, and getPost keeps overlaying it for as long as the post reads),
 * nothing is retried, and the listener hears about it once.
 */
function reportTerminal(
  dataDir: string,
  id: string,
  reason: string,
  event: ContentSaveEvent,
): void {
  const pending = pendingEdits.get(dataDir)?.get(id);
  if (!pending || pending.terminal !== null) return;
  pending.terminal = reason;
  cancelFlush(dataDir, id);
  contentSaveListener?.(event);
}

function scheduleFlush(dataDir: string, id: string, delayMs: number): void {
  let timers = pendingTimers.get(dataDir);
  if (!timers) {
    timers = new Map();
    pendingTimers.set(dataDir, timers);
  }
  const existing = timers.get(id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(id);
    flushPostEdits(dataDir, id);
  }, delayMs);
  // Never hold the process open for a debounce timer; quit flushes explicitly.
  timer.unref();
  timers.set(id, timer);
}

/**
 * Buffer a content edit and (re)start its debounce. The text is buffered first,
 * unconditionally: when the post is no longer in the index the edit can never
 * be saved, but it is still the user's work, so it is kept and the terminal
 * failure is reported — never dropped in silence.
 */
export function queueContent(dataDir: string, id: string, content: string): void {
  const pending = pendingFor(dataDir, id);
  pending.content = content;
  scheduleIfSavable(dataDir, id, pending);
}

/**
 * Buffer metadata field edits and (re)start the debounce, exactly as content
 * is buffered: from here the store owns them, so quitting or closing the window
 * the moment after a keystroke cannot lose them.
 *
 * Returns why the edit was refused, or null when it was buffered. The caller
 * has already validated the edit's shape; the one rule left is the slug's
 * uniqueness, which needs the index and the other posts' pending edits. A
 * refused edit is not buffered, so the buffer never holds a value that could
 * not be written.
 */
export function queueMetadata(dataDir: string, id: string, edits: EditablePostMetadata): string | null {
  if (!index.getEntry(dataDir, id)) return "Post not found";
  const slug = edits.slug;
  if (typeof slug === "string" && slug.length > 0) {
    const conflict = slugConflictMessage(dataDir, id, slug);
    if (conflict) return conflict;
  }
  const pending = pendingFor(dataDir, id);
  Object.assign(pending.frontMatter, edits);
  scheduleIfSavable(dataDir, id, pending);
  return null;
}

function scheduleIfSavable(dataDir: string, id: string, pending: PendingEdit): void {
  const entry = index.getEntry(dataDir, id);
  if (!entry) {
    reportTerminal(dataDir, id, POST_MISSING_REASON, { kind: "post-missing", dataDir, id });
    return;
  }
  if (isEditLocked(entry.status)) {
    reportTerminal(dataDir, id, lockedReason(entry.status), {
      kind: "locked",
      dataDir,
      id,
      status: entry.status,
    });
    return;
  }
  // The post is there (or back, or unlocked): a later terminal state is
  // reported anew.
  pending.terminal = null;
  scheduleFlush(dataDir, id, PENDING_FLUSH_DELAY_MS);
}

/**
 * Write a post's pending edits to disk now. Returns true only when they are
 * durable — flushed, or nothing was pending — so `true` can be trusted to mean
 * saved. A failed write keeps the buffer and schedules a retry; a post
 * that left the index keeps the buffer with no retry (terminal). Both tell the
 * listener, and both return false.
 */
export function flushPostEdits(dataDir: string, id: string): boolean {
  if (getPending(dataDir, id) === undefined) return true;

  // Re-checked at write time, not only when the edit was queued. The debounce
  // window is exactly long enough for the post to be published between a
  // keystroke and its write, and the quit flush runs later still — so queue
  // time alone would leave the autosave accident the lock exists to prevent.
  const entry = index.getEntry(dataDir, id);
  if (entry && isEditLocked(entry.status)) {
    reportTerminal(dataDir, id, lockedReason(entry.status), {
      kind: "locked",
      dataDir,
      id,
      status: entry.status,
    });
    return false;
  }

  try {
    // updatePost reads through the overlay, so an empty update persists the
    // pending edits and clears the buffer.
    const post = updatePost(dataDir, id, {});
    if (!post) {
      // The post's file vanished out of band. Retrying cannot bring it back, so
      // the text is kept and reported rather than discarded as if it saved.
      reportTerminal(dataDir, id, POST_MISSING_REASON, { kind: "post-missing", dataDir, id });
      return false;
    }
    const summary = index.getEntry(dataDir, id);
    if (summary) contentSaveListener?.({ kind: "saved", dataDir, id, summary });
    return true;
  } catch (err) {
    // The message is for the user; the error itself travels alongside it so the
    // IPC layer can log a stack. It used to be flattened to a string here, which
    // left the app's most debugging-critical failure - a post's text not
    // reaching disk - recording no error type and no stack anywhere.
    const message = err instanceof Error ? err.message : String(err);
    scheduleFlush(dataDir, id, PENDING_RETRY_DELAY_MS);
    contentSaveListener?.({ kind: "save-failed", dataDir, id, message, error: err });
    return false;
  }
}

/**
 * Flush every buffered edit, everywhere. Used at quit: the returned failures
 * are every post whose edits are still only in memory — a write that failed and
 * a post whose file is gone alike — so the quit path can never exit silently on
 * either.
 */
export function flushAllPendingEdits(): { id: string; message: string }[] {
  const failures: { id: string; message: string }[] = [];
  for (const [dataDir, posts] of pendingEdits) {
    for (const id of [...posts.keys()]) {
      try {
        if (flushPostEdits(dataDir, id)) continue;
        failures.push({
          id,
          message: posts.get(id)?.terminal ?? "save failed",
        });
      } catch (err) {
        failures.push({ id, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return failures;
}

// --- List ---

export function listDrafts(dataDir: string): PostSummary[] {
  return summaries(dataDir, "draft", byCreatedDesc);
}

export function listReady(dataDir: string): PostSummary[] {
  return summaries(dataDir, "ready", byCreatedDesc);
}

export function listPublished(dataDir: string, offset: number, limit: number): PostSummary[] {
  return index
    .listByStatus(dataDir, "published")
    .sort(byPublishedDesc)
    .slice(offset, offset + limit)
    .map((entry) => ({ frontMatter: entry }));
}

export function countPublished(dataDir: string): number {
  return index.countByStatus(dataDir, "published");
}

export function listExpired(dataDir: string, offset: number, limit: number): PostSummary[] {
  return index
    .listByStatus(dataDir, "expired")
    .sort(byExpiredDesc)
    .slice(offset, offset + limit)
    .map((entry) => ({ frontMatter: entry }));
}

export function countExpired(dataDir: string): number {
  return index.countByStatus(dataDir, "expired");
}

function summaries(
  dataDir: string,
  status: PostStatus,
  compare: (a: PostIndexEntry, b: PostIndexEntry) => number
): PostSummary[] {
  return index
    .listByStatus(dataDir, status)
    .sort(compare)
    .map((entry) => ({ frontMatter: entry }));
}

// --- Read ---

export function getPost(dataDir: string, id: string): Post | null {
  const entry = index.getEntry(dataDir, id);
  if (!entry) return null;

  const filePath = filePathFor(dataDir, entry);
  if (!fs.existsSync(filePath)) {
    // The file vanished out of band; drop the stale entry and report not-found.
    index.rebuild(dataDir);
    return null;
  }
  const post = readPost(filePath);
  // Read through the write-behind buffer: every reader sees the newest edits,
  // and any full write (updatePost, changeStatus) persists them as a side effect.
  const pending = getPending(dataDir, id);
  if (pending) {
    if (pending.content !== undefined) post.content = pending.content;
    applyMetadata(post.frontMatter, pending.frontMatter);
  }
  return post;
}

/** Applies metadata edits to front matter: null removes a key, undefined leaves it. */
function applyMetadata(fm: PostFrontMatter, edits: EditablePostMetadata): void {
  for (const [key, value] of Object.entries(edits)) {
    if (value === null) delete fm[key];
    else if (value !== undefined) fm[key] = value;
  }
}

// --- Create ---

export function createPost(
  dataDir: string,
  target: string,
  language: string,
  sourceId?: string
): Post {
  const now = utcNow();
  const id = nanoid();

  const frontMatter: PostFrontMatter = {
    id,
    target,
    status: "draft",
    language,
    ...(sourceId ? { sourceId } : {}),
    createdAtUtc: formatUtcIso(now),
    updatedAtUtc: formatUtcIso(now),
  };

  const fileName = postFileName(now, id);
  const filePath = path.join(postsDir(dataDir), fileName);

  writePost(filePath, frontMatter, "");
  index.upsertEntry(dataDir, projectIndexEntry(frontMatter, fileName, ""));

  return { frontMatter, content: "", filePath };
}

// --- Update (content + editable metadata only) ---

export function updatePost(
  dataDir: string,
  id: string,
  updates: { content?: string; frontMatter?: EditablePostMetadata }
): Post | null {
  const post = getPost(dataDir, id);
  if (!post) return null;

  const fm = post.frontMatter;
  if (updates.frontMatter) {
    const requestedSlug = updates.frontMatter.slug;
    if (typeof requestedSlug === "string" && requestedSlug.length > 0) {
      const conflict = slugConflictMessage(dataDir, id, requestedSlug);
      if (conflict) throw new Error(conflict);
    }
    applyMetadata(fm, updates.frontMatter);
  }
  fm.updatedAtUtc = formatUtcIso(utcNow());

  if (updates.content !== undefined) post.content = updates.content;

  // The filename is derived from immutable fields, so it never changes.
  writePost(post.filePath, fm, post.content);
  index.upsertEntry(dataDir, projectIndexEntry(fm, path.basename(post.filePath), post.content));

  // What was written is the newest of everything — the overlay carried in by
  // getPost, or an explicit update that supersedes it.
  clearPending(dataDir, id);
  return post;
}

/**
 * Why `slug` cannot be given to post `id`, or null when it is free. Slugs
 * compare case-insensitively, against each post's newest slug: the one buffered
 * for it, else its index entry. The index is reconciled with the files first,
 * so an out-of-band edit is seen without reading every post body — a slug
 * edit runs this on the main process.
 */
function slugConflictMessage(dataDir: string, id: string, slug: string): string | null {
  index.refresh(dataDir);
  const normalized = slug.toLowerCase();
  const pending = pendingEdits.get(dataDir);
  for (const entry of index.allEntries(dataDir)) {
    if (entry.id === id) continue;
    const buffered = pending?.get(entry.id)?.frontMatter;
    const current = buffered && "slug" in buffered ? buffered.slug : entry.slug;
    if (typeof current === "string" && current.toLowerCase() === normalized) {
      return `Another post already uses the slug "${slug}"`;
    }
  }
  return null;
}

// --- Status change ---

export function changeStatus(dataDir: string, id: string, newStatus: PostStatus): Post | null {
  const post = getPost(dataDir, id);
  if (!post) return null;

  const fm = post.frontMatter;
  if (fm.status === newStatus) return post;

  const now = utcNow();
  applyStatusTransition(fm, newStatus, now);
  fm.updatedAtUtc = formatUtcIso(now);

  writePost(post.filePath, fm, post.content);
  index.upsertEntry(dataDir, projectIndexEntry(fm, path.basename(post.filePath), post.content));

  // The write carried the overlay (getPost applied it above).
  clearPending(dataDir, id);
  return post;
}

/**
 * Returns the index projection (summary) for a post, or null if unknown. This
 * is the single source of truth for a post's list representation — including
 * the derived excerpt — so callers never reconstruct it.
 */
export function getPostSummary(dataDir: string, id: string): PostIndexEntry | null {
  return index.getEntry(dataDir, id);
}

// --- Referrers (posts that link this one as their source) ---

export function listReferrers(dataDir: string, id: string): string[] {
  return index
    .allEntries(dataDir)
    .filter((entry) => entry.sourceId === id)
    .map((entry) => entry.id);
}

export function postExists(dataDir: string, id: string): boolean {
  return index.getEntry(dataDir, id) !== null;
}

// --- Delete ---

export function deletePost(dataDir: string, id: string): boolean {
  const entry = index.getEntry(dataDir, id);
  if (!entry) return false;

  // Deleting a post deliberately discards its edits, buffered ones included.
  clearPending(dataDir, id);

  // Referential integrity: a post that links the deleted one as its source
  // would otherwise dangle, so clear that link. This is a system operation, not
  // a user edit, so it is exempt from the published lock and does not bump
  // updatedAtUtc — mirroring renameTarget.
  clearSourceReferences(dataDir, id);

  const filePath = filePathFor(dataDir, entry);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  index.removeEntry(dataDir, id);

  const assets = assetDir(dataDir, id);
  if (fs.existsSync(assets)) {
    fs.rmSync(assets, { recursive: true });
  }

  return true;
}

function clearSourceReferences(dataDir: string, sourceId: string): void {
  // A referrer that cannot be read is skipped (and logged) and keeps its link;
  // once repaired it shows a source that no longer exists, which the editor
  // lets the user unlink. It does not block the delete: it is not a post the
  // app can show anyway.
  rewriteMatchingPosts(
    dataDir,
    (entry) => entry.sourceId === sourceId,
    (fm) => {
      delete fm.sourceId;
    },
  );
}

// --- Bulk rewrite ---

/** A post file a bulk pass could not read, and why. */
export interface SkippedPostFile {
  fileName: string;
  reason: string;
}

/** What a bulk rewrite did: posts rewritten, and files it could not read. */
export interface BulkRewriteResult {
  updated: number;
  skipped: SkippedPostFile[];
}

/**
 * Rewrites the front matter of every indexed post that `matches`, as a system
 * operation: exempt from the published lock, and updatedAtUtc is left alone.
 *
 * A post file that cannot be read (hand-edited into invalid YAML) is skipped
 * and reported, not thrown, as the index skips such a file; it is not a post
 * the app can show anyway. A failed write does throw, which stops the pass.
 * The index is written once, including for a pass cut short, so it matches
 * every file already rewritten.
 */
function rewriteMatchingPosts(
  dataDir: string,
  matches: (entry: PostIndexEntry) => boolean,
  rewrite: (fm: PostFrontMatter) => void,
): BulkRewriteResult {
  const rewritten: PostIndexEntry[] = [];
  const skipped: SkippedPostFile[] = [];
  try {
    for (const entry of index.allEntries(dataDir)) {
      if (!matches(entry)) continue;
      const filePath = filePathFor(dataDir, entry);
      // An index entry whose file vanished out of band is skipped; the next
      // load reconciles it away.
      if (!fs.existsSync(filePath)) continue;
      let post: Post;
      let projected: PostIndexEntry;
      try {
        post = readPost(filePath);
        rewrite(post.frontMatter);
        projected = projectIndexEntry(post.frontMatter, entry.fileName, post.content);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logWarn("post file skipped by a bulk rewrite", { fileName: entry.fileName, reason, error: serializeError(err) });
        skipped.push({ fileName: entry.fileName, reason });
        continue;
      }
      writePost(filePath, post.frontMatter, post.content);
      rewritten.push(projected);
    }
  } finally {
    index.upsertEntries(dataDir, rewritten);
  }
  return { updated: rewritten.length, skipped };
}

// --- Target rename ---

/**
 * Rewrites every post on `oldName` to `newName`. The caller saves the target
 * list only after this returns, so a rename that fails partway leaves the old
 * target valid and can simply be run again: posts already on the new name no
 * longer match and are passed over. Files it could not read are returned, so
 * the user hears which posts still name the old target.
 */
export function renameTarget(dataDir: string, oldName: string, newName: string): BulkRewriteResult {
  return rewriteMatchingPosts(
    dataDir,
    (entry) => entry.target === oldName,
    (fm) => {
      fm.target = newName;
    },
  );
}
