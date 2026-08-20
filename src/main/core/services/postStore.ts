/**
 * Post store: the create/read/update/status/delete/list API over post files.
 *
 * Posts live in a single `posts/` directory; each file's name is fixed for its
 * lifetime, so a status change or edit rewrites the file in place rather than
 * moving it. Every mutation writes the `.md` file (the source of truth) and
 * then updates the derived index. Listing reads from the index alone — no post
 * bodies are read to render a list, so the published archive stays cheap.
 *
 * Content edits stream through a write-behind buffer owned by this store: the
 * renderer sends every editor change via queueContent, the store coalesces
 * them into one disk write per debounce window, and getPost overlays the
 * pending content so every reader — metadata patches, status changes, AI
 * analysis, export — always sees the newest text without knowing the buffer
 * exists. Because updatePost and changeStatus read through getPost, any full
 * write persists the pending content as a side effect and clears the buffer.
 * The main process therefore never depends on the renderer to flush: quit
 * calls flushAllPendingContent and the newest keystroke is on disk.
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
import { utcNow, formatUtcIso, compareInstants } from "../shared/timestamps.js";
import { postFileName } from "../shared/filenames.js";
import { readPost, writePost, projectIndexEntry } from "./postFile.js";
import { applyStatusTransition, isEditLocked } from "../shared/postLifecycle.js";
import * as index from "./postIndex.js";

export function clearCache(dataDir: string): void {
  index.clearCache(dataDir);
}

export function rebuildIndex(dataDir: string): index.RebuildResult {
  return index.rebuild(dataDir);
}

function postsDir(dataDir: string): string {
  return path.join(dataDir, "posts");
}

function filePathFor(dataDir: string, entry: PostIndexEntry): string {
  return path.join(postsDir(dataDir), entry.fileName);
}

// --- Pending content (write-behind buffer) ---

const PENDING_FLUSH_DELAY_MS = 750;
const PENDING_RETRY_DELAY_MS = 5000;

/**
 * One post's newest text not yet on disk.
 *
 * `terminal` is why no write from this path can land — the post is gone from
 * the index, or it is locked — and null while the edit is still savable. The
 * text is kept either way (it is the user's work), but a terminal edit is never
 * scheduled, and setting the reason is also what makes the failure announce
 * once rather than on every keystroke.
 */
interface PendingEdit {
  content: string;
  terminal: string | null;
}

const POST_MISSING_REASON = "post file is missing";

function lockedReason(status: PostStatus): string {
  return `post is ${status} and locked`;
}

// dataDir -> post id -> newest content not yet on disk.
const pendingContent = new Map<string, Map<string, PendingEdit>>();
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
  | { kind: "save-failed"; dataDir: string; id: string; message: string }
  | { kind: "post-missing"; dataDir: string; id: string }
  | { kind: "locked"; dataDir: string; id: string; status: PostStatus };

// Single subscriber (the IPC layer), which broadcasts to windows. The store
// stays free of Electron types.
let contentSaveListener: ((event: ContentSaveEvent) => void) | null = null;

export function setContentSaveListener(listener: ((event: ContentSaveEvent) => void) | null): void {
  contentSaveListener = listener;
}

function getPending(dataDir: string, id: string): string | undefined {
  return pendingContent.get(dataDir)?.get(id)?.content;
}

function setPending(dataDir: string, id: string, content: string): PendingEdit {
  let posts = pendingContent.get(dataDir);
  if (!posts) {
    posts = new Map();
    pendingContent.set(dataDir, posts);
  }
  const existing = posts.get(id);
  if (existing) {
    existing.content = content;
    return existing;
  }
  const created: PendingEdit = { content, terminal: null };
  posts.set(id, created);
  return created;
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
  pendingContent.get(dataDir)?.delete(id);
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
  const pending = pendingContent.get(dataDir)?.get(id);
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
    flushPostContent(dataDir, id);
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
  const pending = setPending(dataDir, id, content);
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
 * Write a post's pending content to disk now. Returns true only when the text
 * is durable — flushed, or nothing was pending — so `true` can be trusted to
 * mean saved. A failed write keeps the buffer and schedules a retry; a post
 * that left the index keeps the buffer with no retry (terminal). Both tell the
 * listener, and both return false.
 */
export function flushPostContent(dataDir: string, id: string): boolean {
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
    // pending content and clears the buffer.
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
    const message = err instanceof Error ? err.message : String(err);
    scheduleFlush(dataDir, id, PENDING_RETRY_DELAY_MS);
    contentSaveListener?.({ kind: "save-failed", dataDir, id, message });
    return false;
  }
}

/**
 * Flush every buffered edit, everywhere. Used at quit: the returned failures
 * are every post whose text is still only in memory — a write that failed and a
 * post whose file is gone alike — so the quit path can never exit silently on
 * either.
 */
export function flushAllPendingContent(): { id: string; message: string }[] {
  const failures: { id: string; message: string }[] = [];
  for (const [dataDir, posts] of pendingContent) {
    for (const id of [...posts.keys()]) {
      try {
        if (flushPostContent(dataDir, id)) continue;
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

function byCreatedDesc(a: PostIndexEntry, b: PostIndexEntry): number {
  return compareInstants(b.createdAtUtc, a.createdAtUtc) || compareDesc(a.id, b.id);
}

function byPublishedDesc(a: PostIndexEntry, b: PostIndexEntry): number {
  return (
    compareInstants(b.publishedAtUtc ?? "", a.publishedAtUtc ?? "") ||
    compareInstants(b.createdAtUtc, a.createdAtUtc) ||
    compareDesc(a.id, b.id)
  );
}

function byExpiredDesc(a: PostIndexEntry, b: PostIndexEntry): number {
  return (
    compareInstants(b.expiredAtUtc ?? "", a.expiredAtUtc ?? "") ||
    compareInstants(b.createdAtUtc, a.createdAtUtc) ||
    compareDesc(a.id, b.id)
  );
}

function compareDesc(a: string, b: string): number {
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
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
  // Read through the write-behind buffer: every reader sees the newest content,
  // and any full write (updatePost, changeStatus) persists it as a side effect.
  const pending = post ? getPending(dataDir, id) : undefined;
  if (post && pending !== undefined) post.content = pending;
  return post;
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
    for (const [key, value] of Object.entries(updates.frontMatter)) {
      if (value === null) {
        delete fm[key];
      } else if (value !== undefined) {
        fm[key] = value;
      }
    }
  }
  fm.updatedAtUtc = formatUtcIso(utcNow());

  if (updates.content !== undefined) post.content = updates.content;

  // The filename is derived from immutable fields, so it never changes.
  writePost(post.filePath, fm, post.content);
  index.upsertEntry(dataDir, projectIndexEntry(fm, path.basename(post.filePath), post.content));

  // What was written is the newest content — either the overlay carried in by
  // getPost or an explicit updates.content that supersedes it.
  clearPending(dataDir, id);
  return post;
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

  // The write carried the overlay content (getPost applied it above).
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

  const assetDir = path.join(dataDir, "assets", id);
  if (fs.existsSync(assetDir)) {
    fs.rmSync(assetDir, { recursive: true });
  }

  return true;
}

function clearSourceReferences(dataDir: string, sourceId: string): void {
  for (const entry of index.allEntries(dataDir)) {
    if (entry.sourceId !== sourceId) continue;
    const filePath = filePathFor(dataDir, entry);
    if (!fs.existsSync(filePath)) continue;
    const post = readPost(filePath);
    delete post.frontMatter.sourceId;
    writePost(filePath, post.frontMatter, post.content);
    index.upsertEntry(dataDir, projectIndexEntry(post.frontMatter, entry.fileName, post.content));
  }
}

// --- Target rename ---

export function renameTarget(dataDir: string, oldName: string, newName: string): number {
  let count = 0;
  for (const entry of index.allEntries(dataDir)) {
    if (entry.target !== oldName) continue;
    const filePath = filePathFor(dataDir, entry);
    // Tolerate an index entry whose file vanished out of band — skip it (the next
    // load reconciles the stale entry away) instead of throwing partway through
    // and leaving some posts renamed and others not. Mirrors clearSourceReferences.
    if (!fs.existsSync(filePath)) continue;
    const post = readPost(filePath);
    post.frontMatter.target = newName;
    writePost(filePath, post.frontMatter, post.content);
    index.upsertEntry(dataDir, projectIndexEntry(post.frontMatter, entry.fileName, post.content));
    count++;
  }
  return count;
}
