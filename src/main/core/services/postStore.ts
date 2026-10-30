/**
 * Post store: the create/read/update/status/delete/list API over post files.
 *
 * Posts live in a single `posts/` directory; each file's name is fixed for its
 * lifetime, so a status change or edit rewrites the file in place rather than
 * moving it. Every mutation writes the `.md` file (the only authority) and
 * then updates the in-memory post list read from the files when the workspace
 * opened (postCatalog). Listing reads from that list alone.
 *
 * Edits stream through a write-behind buffer owned by this store: the renderer
 * sends every editor change via queueContent and every metadata field edit via
 * queueMetadata, the store coalesces them into one disk write per debounce
 * window, and getPost overlays the pending content and metadata so every
 * reader — status changes, AI calls, export — always sees the newest edit
 * without knowing the buffer exists. Every write of an unlocked post goes
 * through rewritePost, which writes the pending edits with it and clears the
 * buffer. The main process therefore never depends on the renderer to flush:
 * quit runs flushAllPendingEdits on the persistent storage worker and
 * the newest keystroke, in the editor or a metadata field, is on disk.
 *
 * The modified time (`updatedAtUtc`) follows content-lifecycle-conventions:
 * rewritePost moves it only when the post's content differs from the file it
 * read, and an asset change moves it too. A status change, locking and a
 * save of unchanged text leave it alone.
 *
 * The rule the buffer is built on: the store never reports success for text it
 * did not persist. Text that is not on disk is either retried (a failed write)
 * or reported as terminal (the post is gone from the list, so no retry can
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
import { comparatorFor } from "@shared/postOrder";
import type { UnreadablePostFile, PostDeleteResult } from "@shared/types";
import { isPostId, postFileName } from "../shared/filenames.js";
import { readPost, writePost, projectIndexEntry, contentSnapshot, serializePost } from "./postFile.js";
import { applyStatusTransition, isPostStatus } from "../shared/postLifecycle.js";
import * as index from "./postCatalog.js";
import { carryingText } from "@shared/i18n/carriedMessage";
import { assetDir } from "./assetStore.js";
import { serializeError, warn as logWarn } from "./logger.js";
import { message, type Message } from "@shared/i18n/translate";
import { validatePostUpdate } from "../shared/postUpdate.js";

export function clearCache(dataDir: string): void {
  index.clearCache(dataDir);
}

/**
 * Rereads the post files, and counts asset folders whose post no longer exists.
 *
 * deletePost removes a post's assets with it, but a `.md` deleted outside the
 * app leaves `assets/<id>/` behind with nothing in the UI that can reach it —
 * unlistable, unopenable, and invisible. Nothing here deletes them: they are the
 * user's uploads, and a `.md` can be deleted by accident or restored from git.
 * Saying how many there are, after a reread the user asked for, is the path to
 * them that did not exist.
 */
export function rereadPosts(dataDir: string): index.RereadResult & { orphanedAssets: number } {
  const result = index.reread(dataDir);
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
 * it, the metadata fields changed since the last write, and when the last of
 * them was made — the modified time they give the post when they are written.
 *
 * `terminal` is why no write from this path can land — the post is gone from
 * the post list, or it is locked — and null while the edit is still savable. The
 * text is kept either way (it is the user's work), but a terminal edit is never
 * scheduled, and setting the reason is also what makes the failure announce
 * once rather than on every keystroke.
 */
interface PendingEdit {
  // Captured once for semantic edit comparisons. Only a fresh disk read at
  // publication may authorize writing the post or determine its current fields.
  authorBaseline?: Post | null;
  content?: string;
  frontMatter: EditablePostMetadata;
  editedAt: Date;
  terminal: string | null;
}

const POST_MISSING_REASON = "post file is missing";
const LOCKED_REASON = "post is locked";

// dataDir -> post id -> newest edits not yet on disk.
const pendingEdits = new Map<string, Map<string, PendingEdit>>();
const pendingTimers = new Map<string, Map<string, NodeJS.Timeout>>();

/**
 * What became of a buffered edit. Retryable and terminal are deliberately
 * distinct: `save-failed` is retryable (the same write can land later), while
 * `post-missing` and `locked` are terminal — no retry can bring a deleted file
 * back or unlock a post, so folding either into the retry loop would spin
 * forever. None is ever silent.
 */
export type ContentSaveEvent =
  | { kind: "saved"; dataDir: string; id: string; summary: PostIndexEntry }
  | { kind: "save-failed"; dataDir: string; id: string; message: string; error: unknown }
  | { kind: "post-missing"; dataDir: string; id: string }
  | { kind: "locked"; dataDir: string; id: string };

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
    pending = { frontMatter: {}, editedAt: utcNow(), terminal: null };
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
 * in the post list, or it is locked. The buffered text stays (it is the user's
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
 * unconditionally: when the post is no longer in the post list the edit can never
 * be saved, but it is still the user's work, so it is kept and the terminal
 * failure is reported — never dropped in silence.
 */
export function queueContent(dataDir: string, id: string, content: string, editedAt = utcNow()): void {
  const pending = pendingFor(dataDir, id);
  const before = pendingAuthorSnapshot(dataDir, id, pending);
  pending.content = content;
  if (before === null || before !== pendingAuthorSnapshot(dataDir, id, pending)) pending.editedAt = editedAt;
  scheduleIfSavable(dataDir, id, pending);
}

/**
 * Buffer metadata field edits and (re)start the debounce, exactly as content
 * is buffered: from here the store owns them, so quitting or closing the window
 * the moment after a keystroke cannot lose them.
 *
 * Returns why the edit was refused, or null when it was buffered. The caller
 * has already validated the edit's shape; the one rule left is the slug's
 * uniqueness, which needs the post list and the other posts' pending edits. A
 * refused edit is not buffered, so the buffer never holds a value that could
 * not be written.
 */
export function queueMetadata(dataDir: string, id: string, edits: EditablePostMetadata, editedAt = utcNow()): Message | null {
  if (!index.getEntry(dataDir, id)) return message("metadata.refusedNotFound");
  const slug = edits.slug;
  if (typeof slug === "string" && slug.length > 0) {
    const conflict = slugConflictMessage(dataDir, id, slug);
    if (conflict) return conflict;
  }
  const pending = pendingFor(dataDir, id);
  const before = pendingAuthorSnapshot(dataDir, id, pending);
  Object.assign(pending.frontMatter, edits);
  if (before === null || before !== pendingAuthorSnapshot(dataDir, id, pending)) pending.editedAt = editedAt;
  scheduleIfSavable(dataDir, id, pending);
  return null;
}

function pendingAuthorSnapshot(dataDir: string, id: string, pending: PendingEdit): string | null {
  if (pending.authorBaseline === undefined) {
    try {
      pending.authorBaseline = readFromDisk(dataDir, id);
    } catch {
      // An unreadable baseline must not discard the user's buffered edit. A
      // later flush still reads the actual file and can save if it is readable.
      pending.authorBaseline = null;
    }
  }
  if (pending.authorBaseline === null) return null;
  const post = structuredClone(pending.authorBaseline);
  overlayPending(post, pending);
  return contentSnapshot(post);
}

function scheduleIfSavable(dataDir: string, id: string, pending: PendingEdit): void {
  const entry = index.getEntry(dataDir, id);
  if (!entry) {
    reportTerminal(dataDir, id, POST_MISSING_REASON, { kind: "post-missing", dataDir, id });
    return;
  }
  if (entry.locked === true) {
    reportTerminal(dataDir, id, LOCKED_REASON, { kind: "locked", dataDir, id });
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
 * that left the post list keeps the buffer with no retry (terminal). Both tell the
 * listener, and both return false.
 */
export function flushPostEdits(dataDir: string, id: string): boolean {
  if (getPending(dataDir, id) === undefined) return true;

  try {
    // updatePost writes through the overlay, so an empty update persists the
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
    if (err instanceof PostLockedError) {
      reportTerminal(dataDir, id, LOCKED_REASON, { kind: "locked", dataDir, id });
      return false;
    }
    // The message is for the user; the error itself travels alongside it so the
    // IPC layer can log a stack. Flattened to a string here, the app's most
    // debugging-critical failure - a post's text not reaching disk - would
    // record no error type and no stack anywhere.
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

/** The post files the list could not read, each shown as damaged with its path. */
export function unreadablePosts(dataDir: string): UnreadablePostFile[] {
  return index.unreadableFiles(dataDir);
}

/**
 * One status's posts, in its section's order: all of them, or the page
 * `page` names.
 */
export function listByStatus(
  dataDir: string,
  status: PostStatus,
  page?: { offset: number; limit: number },
): PostSummary[] {
  const sorted = index.listByStatus(dataDir, status).sort(comparatorFor(status));
  const shown = page ? sorted.slice(page.offset, page.offset + page.limit) : sorted;
  return shown.map((entry) => ({ frontMatter: entry }));
}

export function countByStatus(dataDir: string, status: PostStatus): number {
  return index.countByStatus(dataDir, status);
}

// --- Read ---

export function getPost(dataDir: string, id: string): Post | null {
  const post = readFromDisk(dataDir, id);
  // Read through the write-behind buffer: every reader sees the newest edits.
  if (post) overlayPending(post, getPending(dataDir, id));
  return post;
}

/** The post as its file holds it, or null when it is not listed or its file is gone. */
function readFromDisk(dataDir: string, id: string): Post | null {
  const entry = index.getEntry(dataDir, id);
  if (!entry) return null;

  const filePath = filePathFor(dataDir, entry);
  if (!fs.existsSync(filePath)) {
    // The file vanished out of band; reread the list and report not-found.
    index.reread(dataDir);
    return null;
  }
  const post = readPost(filePath);
  // The list locates a candidate file; only its current identity authorizes
  // reading or rewriting it for this caller. Outside replacements must never
  // receive another post's buffered edits. A reread discovers the new id.
  return post.frontMatter.id === id ? post : null;
}

function overlayPending(post: Post, pending: PendingEdit | undefined): void {
  if (!pending) return;
  if (pending.content !== undefined) post.content = pending.content;
  applyMetadata(post.frontMatter, pending.frontMatter);
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

// --- Writes ---

class PostLockedError extends Error {
  constructor() {
    super("This post is locked. Unlock it to edit it.");
    this.name = "PostLockedError";
  }
}

/**
 * The one way an existing post is written. `change` edits the post as the
 * file holds it plus, for an unlocked post, its buffered edits — so the write
 * persists them and clears the buffer. A locked post's buffered edits stay
 * buffered: only unlocking makes them writable again.
 *
 * The modified time moves when the content then differs from the file, or when
 * `contentEdited` says the post's content changed outside the file (an asset),
 * and it records when the edit was made: now for `change` itself, and when
 * they were typed for buffered edits, which can be written seconds or minutes
 * later. A file that would not change is not written at all. The filename is
 * derived from immutable fields, so it never changes.
 */
function rewritePost(
  dataDir: string,
  id: string,
  change: (post: Post) => void | false,
  contentEdited = false,
  requiresEditable = false,
): Post | null {
  const onDisk = readFromDisk(dataDir, id);
  if (!onDisk) return null;
  // The file may have been locked outside the app since the list was read.
  // Status and lock operations remain permitted, but authored writes must
  // refuse rather than return a post that left their buffer unsaved.
  if (requiresEditable && onDisk.frontMatter.locked === true) throw new PostLockedError();

  const post = structuredClone(onDisk);
  const writesPending = onDisk.frontMatter.locked !== true;
  const pending = writesPending ? getPending(dataDir, id) : undefined;
  overlayPending(post, pending);
  const onFile = contentSnapshot(onDisk);
  const buffered = contentSnapshot(post);
  if (change(post) === false) return post;

  const fm = post.frontMatter;
  const written = contentSnapshot(post);
  if (contentEdited || (written !== onFile && written !== buffered)) {
    fm.updatedAtUtc = formatUtcIso(utcNow());
  } else if (pending && written !== onFile) {
    fm.updatedAtUtc = formatUtcIso(pending.editedAt);
  }
  if (serializePost(onDisk.frontMatter, onDisk.content) !== serializePost(fm, post.content)) {
    writePost(post.filePath, fm, post.content, true);
  }
  index.upsertEntry(dataDir, projectIndexEntry(fm, path.basename(post.filePath), post.content));

  if (writesPending) clearPending(dataDir, id);
  return post;
}

/** Writes content and editable metadata, checking the source's current lock. */
export function updatePost(
  dataDir: string,
  id: string,
  updates: { content?: string; frontMatter?: EditablePostMetadata }
): Post | null {
  return rewritePost(dataDir, id, (post) => {
    const validation = validatePostUpdate(post.frontMatter, updates);
    if (!validation.ok) throw new Error(validation.message);
    const edits = validation.edits;
    if (typeof edits.sourceId === "string" && edits.sourceId && !postExists(dataDir, edits.sourceId)) {
      throw new Error("Source post not found");
    }
    const requestedSlug = edits.slug;
    if (typeof requestedSlug === "string" && requestedSlug.length > 0 && slugConflictMessage(dataDir, id, requestedSlug)) {
      throw new Error(`Another post already uses the slug ${JSON.stringify(requestedSlug)}`);
    }
    applyMetadata(post.frontMatter, edits);
    if (updates.content !== undefined) post.content = updates.content;
  }, false, true);
}

/**
 * Records that a post's attached files changed — an asset uploaded, replaced
 * or deleted — by moving its modified time, with any buffered edits. The
 * source's current lock is checked before writing.
 */
export function recordAssetChange(dataDir: string, id: string): Post | null {
  return rewritePost(dataDir, id, () => {}, true, true);
}

/**
 * Why `slug` cannot be given to post `id`, or null when it is free. Slugs
 * compare case-insensitively, against each post's newest slug: the one buffered
 * for it, else its listed front matter.
 */
function slugConflictMessage(dataDir: string, id: string, slug: string): Message | null {
  const normalized = slug.toLowerCase();
  const pending = pendingEdits.get(dataDir);
  for (const entry of index.allEntries(dataDir)) {
    if (entry.id === id) continue;
    const buffered = pending?.get(entry.id)?.frontMatter;
    const current = buffered && "slug" in buffered ? buffered.slug : entry.slug;
    if (typeof current === "string" && current.toLowerCase() === normalized) {
      return message("metadata.refusedSlugTaken", { slug });
    }
  }
  return null;
}

// --- Status and lock ---

/** Moves a post to `newStatus`, locked or not. Selecting the current status writes nothing. */
export function changeStatus(dataDir: string, id: string, newStatus: PostStatus): Post | null {
  return rewritePost(dataDir, id, (post) => {
    if (post.frontMatter.status === newStatus) return false;
    applyStatusTransition(post.frontMatter, newStatus, utcNow());
  });
}

/**
 * Locks or unlocks a post. Locking writes the buffered edits first, as part
 * of the same write; unlocking makes edits kept while it was locked savable
 * again. The lock itself moves no time.
 */
export function setLocked(dataDir: string, id: string, locked: boolean): Post | null {
  const post = rewritePost(dataDir, id, (next) => {
    if (locked) next.frontMatter.locked = true;
    else delete next.frontMatter.locked;
  });
  const pending = getPending(dataDir, id);
  if (post && !locked && pending) scheduleIfSavable(dataDir, id, pending);
  return post;
}

/**
 * Returns the listed projection (summary) for a post, or null if unknown. This
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

/** Refuse destructive work while copied Markdown files still share one attachment identity. */
export function assertUnambiguousPostId(dataDir: string, id: string): UnreadablePostFile[] {
  const unreadable = index.unreadableFiles(dataDir);
  const files = index.duplicateFiles(dataDir, id);
  if (files.length) throw new Error(carryingText(message("post.duplicateId", { paths: files.join("\n") })));
  return unreadable;
}

export function deletePost(dataDir: string, id: string): PostDeleteResult | null {
  let entry = index.getEntry(dataDir, id);
  if (!entry) return null;
  let filePath = filePathFor(dataDir, entry);
  if (fs.existsSync(filePath)) readPost(filePath);
  const referrerPaths = new Set(index.allEntries(dataDir).filter((row) => row.sourceId === id).map((row) => filePathFor(dataDir, row)));
  const unreadable = assertUnambiguousPostId(dataDir, id);
  // Only the current mapping, and the file's identity as it reads now, may
  // authorize both the unlink and its shared attachment cleanup.
  entry = index.getEntry(dataDir, id);
  if (!entry) return null;
  filePath = filePathFor(dataDir, entry);
  // A file an outside edit gave another id is no longer this post: nothing is deleted.
  if (fs.existsSync(filePath) && readPost(filePath).frontMatter.id !== id) return null;

  // The post goes first. An interruption after this leaves at worst a link to
  // a post that no longer exists, which the editor lets the user clear, never
  // a cleared link to a post that still exists.
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  // Discard buffered edits only once deletion succeeded (or the post is gone).
  // A refused unlink must leave authored work available to autosave and quit.
  clearPending(dataDir, id);
  index.removeEntry(dataDir, id);

  // Referential integrity: a post that links the deleted one as its source
  // would otherwise dangle, so clear that link. This is a system operation, not
  // a user edit, so it is exempt from the lock and does not move updatedAtUtc
  // — mirroring renameTarget.
  let cleanupIncomplete = unreadable.some((file) => referrerPaths.has(file.path));
  try {
    cleanupIncomplete = clearSourceReferences(dataDir, id).skipped.length > 0 || cleanupIncomplete;
  } catch (error) {
    cleanupIncomplete = true;
    logWarn("deleted post source cleanup incomplete", { id, error: serializeError(error) });
  }

  // The attachments go with the post whatever state their assets.json is in.
  const assets = assetDir(dataDir, id);
  try {
    if (fs.existsSync(assets)) fs.rmSync(assets, { recursive: true });
  } catch (error) {
    cleanupIncomplete = true;
    logWarn("deleted post attachment cleanup incomplete", { id, path: assets, error: serializeError(error) });
  }

  return { cleanupIncomplete };
}

function clearSourceReferences(dataDir: string, sourceId: string): BulkRewriteResult {
  // A referrer that cannot be read is skipped (and logged) and keeps its link;
  // once repaired it shows a source that no longer exists, which the editor
  // lets the user unlink. It does not block the delete: it is not a post the
  // app can show anyway.
  return rewriteMatchingPosts(
    dataDir,
    (entry) => entry.sourceId === sourceId,
    (fm) => {
      delete fm.sourceId;
    },
    true,
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
 * Rewrites the front matter of every source post that `matches`, as a system
 * operation: exempt from the lock, and updatedAtUtc is left alone — a rewrite
 * the app makes on its own is not an edit (content-lifecycle-conventions).
 *
 * A post file that cannot be read (hand-edited into invalid YAML) is skipped
 * and reported, not thrown, as the post list does such a file; it is not a post
 * the app can show anyway. A failed write stops an ordinary pass; post-deletion
 * cleanup instead reports it and continues, since its primary deletion already committed.
 * The post list is updated once, including for a pass cut short, so it matches
 * every file already rewritten.
 */
function rewriteMatchingPosts(
  dataDir: string,
  matches: (entry: PostIndexEntry) => boolean,
  rewrite: (fm: PostFrontMatter) => void,
  continueAfterWriteFailure = false,
): BulkRewriteResult {
  const rewritten: PostIndexEntry[] = [];
  const skipped: SkippedPostFile[] = [];
  // Cleanup has already reported unreadable known referrers.
  // An unrelated unreadable file must not make an otherwise complete deletion
  // look partial. This cached set limits diagnostics only, never selection.
  const knownMatches = new Set(index.allEntries(dataDir).filter(matches).map((entry) => entry.fileName));
  const sourceIds = new Set<string>();
  try {
    // A bulk operation selects from the source files, not cached membership:
    // a checkout may add posts or change their target/source since the list
    // was last opened. Read each source once and update the list once below.
    for (const fileName of fs.readdirSync(postsDir(dataDir)).filter((name) => name.endsWith(".md")).sort()) {
      const filePath = path.join(postsDir(dataDir), fileName);
      if (!fs.existsSync(filePath)) continue;
      let post: Post;
      let projected: PostIndexEntry;
      try {
        post = readPost(filePath);
        if (!isPostId(post.frontMatter.id) || !isPostStatus(post.frontMatter.status)) {
          throw new Error("Post identity or status is invalid");
        }
        const current = projectIndexEntry(post.frontMatter, fileName, post.content);
        // Preserve an existing usable owner, even when a new copy sorts before
        // it. Only a missing or incompatible owner permits survivor promotion.
        const owner = index.getEntry(dataDir, current.id);
        let ownerStillUsable = false;
        if (owner && owner.fileName !== fileName) {
          try {
            const owned = readPost(filePathFor(dataDir, owner));
            ownerStillUsable = owned.frontMatter.id === current.id && isPostStatus(owned.frontMatter.status);
            if (ownerStillUsable) projectIndexEntry(owned.frontMatter, owner.fileName, owned.content);
          } catch (error) {
            // An unreadable owner is not evidence that a copy owns its edits.
            // Only an absent source permits promotion without reading identity.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if (ownerStillUsable) throw new Error(`duplicate post id ${current.id}`);
        // Without a surviving listed owner, the first usable source claims
        // the id before filtering; an unmatched source still owns its identity.
        if (sourceIds.has(current.id)) throw new Error(`duplicate post id ${current.id}`);
        sourceIds.add(current.id);
        if (!matches(current)) continue;
        rewrite(post.frontMatter);
        projected = projectIndexEntry(post.frontMatter, fileName, post.content);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logWarn("post file skipped by a bulk rewrite", { fileName, reason, error: serializeError(err) });
        if (!continueAfterWriteFailure || knownMatches.has(fileName)) skipped.push({ fileName, reason });
        continue;
      }
      try {
        writePost(filePath, post.frontMatter, post.content);
        rewritten.push(projected);
      } catch (error) {
        if (!continueAfterWriteFailure) throw error;
        logWarn("post cleanup rewrite failed", { fileName, error: serializeError(error) });
        skipped.push({ fileName, reason: error instanceof Error ? error.message : String(error) });
      }
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
