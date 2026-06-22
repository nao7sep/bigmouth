/**
 * Post store: the create/read/update/status/delete/list API over post files.
 *
 * Posts live in a single `posts/` directory; each file's name is fixed for its
 * lifetime, so a status change or edit rewrites the file in place rather than
 * moving it. Every mutation writes the `.md` file (the source of truth) and
 * then updates the derived index. Listing reads from the index alone — no post
 * bodies are read to render a list, so the published archive stays cheap.
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
import { applyStatusTransition } from "../shared/postLifecycle.js";
import * as index from "./postIndex.js";

export function clearCache(dataDir: string): void {
  index.clearCache(dataDir);
}

export function rebuildIndex(dataDir: string): number {
  return index.rebuild(dataDir);
}

function postsDir(dataDir: string): string {
  return path.join(dataDir, "posts");
}

function filePathFor(dataDir: string, entry: PostIndexEntry): string {
  return path.join(postsDir(dataDir), entry.fileName);
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
  return readPost(filePath);
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
    const post = readPost(filePath);
    post.frontMatter.target = newName;
    writePost(filePath, post.frontMatter, post.content);
    index.upsertEntry(dataDir, projectIndexEntry(post.frontMatter, entry.fileName, post.content));
    count++;
  }
  return count;
}
