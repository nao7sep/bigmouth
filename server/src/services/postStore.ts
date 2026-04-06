/**
 * Post file I/O layer.
 *
 * Posts are stored in subdirectories by status:
 *   posts/drafts/      — all loaded on startup (always small)
 *   posts/ready/       — all loaded on startup (always small)
 *   posts/published/   — loaded in batches by filename sort (grows over time)
 */

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { nanoid } from "nanoid";
import type {
  Post,
  PostFrontMatter,
  PostSummary,
  PostStatus,
} from "../shared/types.js";
import { utcNow, formatForFrontMatter } from "../shared/timestamps.js";
import { warn as logWarn } from "../services/logger.js";
import {
  draftFilename,
  readyFilename,
  publishedFilename,
  statusSubdir,
} from "../shared/filenames.js";

let postsDir = "";
let dataDir = "";

// Lucky cache: maps published post id -> absolute file path.
// Populated as published posts are accessed; evicted on delete or unpublish.
// If an id isn't here, fall back to directory scan.
const pubCache = new Map<string, string>();

export function initPostStore(dataDirectory: string): void {
  dataDir = dataDirectory;
  postsDir = path.join(dataDirectory, "posts");
  pubCache.clear();
}

// --- List ---

/**
 * Lists all drafts (front matter only). Always fully loaded.
 */
export function listDrafts(): PostSummary[] {
  return loadAllSummaries("drafts");
}

/**
 * Lists all ready posts (front matter only). Always fully loaded.
 */
export function listReady(): PostSummary[] {
  return loadAllSummaries("ready");
}

/**
 * Lists a batch of published posts (front matter only).
 * Filenames are sorted descending (newest first). Offset and limit
 * control pagination. Front matter is parsed only for the requested batch.
 * Populates pubCache as a side effect.
 */
export function listPublished(offset: number, limit: number): PostSummary[] {
  const dir = path.join(postsDir, "published");
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();

  const summaries: PostSummary[] = [];
  for (const file of files.slice(offset, offset + limit)) {
    const filePath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const fm = parsed.data as PostFrontMatter;
      if (fm.id) pubCache.set(fm.id, filePath);
      summaries.push({ frontMatter: fm });
    } catch (err) {
      logWarn(`Skipping malformed published file: ${filePath} — ${err instanceof Error ? err.message : err}`);
    }
  }

  return summaries;
}

/**
 * Returns the total number of published posts (for pagination).
 */
export function countPublished(): number {
  const dir = path.join(postsDir, "published");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
}

// --- Read ---

export function getPost(id: string): Post | null {
  const filePath = findPostFile(id);
  if (!filePath) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = matter(raw);

  return {
    frontMatter: parsed.data as PostFrontMatter,
    content: trimBlankLines(parsed.content),
    filePath,
  };
}

function trimBlankLines(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  let end = lines.length - 1;
  while (end >= start && lines[end].trim() === "") end--;
  return start > end ? "" : lines.slice(start, end + 1).join("\n");
}



export function createPost(target: string, language: string, sourceId?: string): Post {
  const now = utcNow();
  const id = nanoid();

  const frontMatter: PostFrontMatter = {
    id,
    target,
    status: "draft",
    language,
    ...(sourceId ? { sourceId } : {}),
    createdAtUtc: formatForFrontMatter(now),
    updatedAtUtc: formatForFrontMatter(now),
  };

  const fileName = draftFilename(now, id);
  const filePath = path.join(postsDir, "drafts", fileName);

  writePostFile(filePath, frontMatter, "");

  return { frontMatter, content: "", filePath };
}

// --- Update ---

export function updatePost(
  id: string,
  updates: {
    content?: string;
    frontMatter?: Partial<PostFrontMatter>;
  }
): Post | null {
  const post = getPost(id);
  if (!post) return null;

  if (updates.frontMatter) {
    for (const [key, value] of Object.entries(updates.frontMatter)) {
      if (value === null) {
        delete (post.frontMatter as Record<string, unknown>)[key];
      } else {
        (post.frontMatter as Record<string, unknown>)[key] = value;
      }
    }
  }
  post.frontMatter.updatedAtUtc = formatForFrontMatter(utcNow());

  if (updates.content !== undefined) {
    post.content = updates.content;
  }

  // Protect immutable fields
  post.frontMatter.id = id;

  // For published posts the slug may have changed, which changes the filename
  if (post.frontMatter.status === "published") {
    const newFilePath = path.join(postsDir, "published", buildFilename(post.frontMatter));
    writePostFile(newFilePath, post.frontMatter, post.content);
    if (newFilePath !== post.filePath) {
      fs.unlinkSync(post.filePath);
      post.filePath = newFilePath;
    }
    pubCache.set(id, post.filePath);
  } else {
    writePostFile(post.filePath, post.frontMatter, post.content);
  }

  return post;
}

// --- Status change ---

/**
 * Changes a post's status. Handles timestamp updates, file renames,
 * and moves between subdirectories.
 */
export function changeStatus(id: string, newStatus: PostStatus): Post | null {
  const post = getPost(id);
  if (!post) return null;

  const oldStatus = post.frontMatter.status;
  if (oldStatus === newStatus) return post;

  const now = utcNow();
  const oldFilePath = post.filePath;

  // Apply timestamp logic
  if (newStatus === "ready") {
    if (!post.frontMatter.slug) {
      throw new Error("Slug is required to move a post to ready status");
    }
    if (!post.frontMatter.readyAtUtc) {
      post.frontMatter.readyAtUtc = formatForFrontMatter(now);
    }
    post.frontMatter.publishedAtUtc = undefined;
  } else if (newStatus === "published") {
    if (!post.frontMatter.slug) {
      throw new Error("Slug is required to publish a post");
    }
    if (!post.frontMatter.readyAtUtc) {
      post.frontMatter.readyAtUtc = formatForFrontMatter(now);
    }
    post.frontMatter.publishedAtUtc = formatForFrontMatter(now);
  } else if (newStatus === "draft") {
    post.frontMatter.readyAtUtc = undefined;
    post.frontMatter.publishedAtUtc = undefined;
  }

  post.frontMatter.status = newStatus;
  post.frontMatter.updatedAtUtc = formatForFrontMatter(now);

  // Determine new filename and subdirectory
  const newFileName = buildFilename(post.frontMatter);
  const newFilePath = path.join(
    postsDir,
    statusSubdir(newStatus),
    newFileName
  );

  writePostFile(newFilePath, post.frontMatter, post.content);
  if (newFilePath !== oldFilePath) {
    fs.unlinkSync(oldFilePath);
  }

  // Keep pubCache in sync
  if (newStatus === "published") {
    pubCache.set(id, newFilePath);
  } else if (oldStatus === "published") {
    pubCache.delete(id);
  }

  post.filePath = newFilePath;
  return post;
}

// --- Delete ---

export function deletePost(id: string): boolean {
  const filePath = findPostFile(id);
  if (!filePath) return false;

  fs.unlinkSync(filePath);
  pubCache.delete(id);

  // Also delete asset directory if it exists
  const assetDir = path.join(dataDir, "assets", id);
  if (fs.existsSync(assetDir)) {
    fs.rmSync(assetDir, { recursive: true });
  }

  return true;
}

// --- Target rename ---

/**
 * Renames a target across all post files in all subdirectories.
 * Returns the number of posts updated.
 */
export function renameTarget(oldName: string, newName: string): number {
  let count = 0;
  for (const sub of ["drafts", "ready", "published"]) {
    const dir = path.join(postsDir, sub);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const fm = parsed.data as PostFrontMatter;

      if (fm.target === oldName) {
        fm.target = newName;
        writePostFile(filePath, fm, parsed.content);
        count++;
      }
    }
  }
  return count;
}

// --- Internal helpers ---

/**
 * Builds the correct filename for a post based on its front matter.
 */
function buildFilename(fm: PostFrontMatter): string {
  if (fm.status === "draft") {
    return draftFilename(new Date(fm.createdAtUtc), fm.id);
  }
  if (fm.status === "ready") {
    return readyFilename(new Date(fm.readyAtUtc!), fm.slug!);
  }
  // published
  return publishedFilename(new Date(fm.publishedAtUtc!), fm.slug!);
}

/**
 * Finds the file path of a post by id.
 * Checks pubCache first for published posts, then scans subdirectories.
 * Draft filenames contain the nanoid for a fast match; ready filenames contain the slug.
 * Published filenames contain neither, so only the fallback parse loop is useful there.
 */
function findPostFile(id: string): string | null {
  // Lucky cache hit for published posts
  const cached = pubCache.get(id);
  if (cached) {
    if (fs.existsSync(cached)) return cached;
    pubCache.delete(id); // stale — file no longer exists
  }

  for (const sub of ["drafts", "ready", "published"]) {
    const dir = path.join(postsDir, sub);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));

    // Quick check: draft/ready filenames may contain the id or slug substring
    if (sub !== "published") {
      for (const file of files) {
        if (file.includes(id)) {
          const filePath = path.join(dir, file);
          const raw = fs.readFileSync(filePath, "utf-8");
          const parsed = matter(raw);
          if ((parsed.data as PostFrontMatter).id === id) return filePath;
        }
      }
    }

    // Fallback: parse all remaining files in this subdir
    for (const file of files) {
      if (sub !== "published" && file.includes(id)) continue; // already checked above
      const filePath = path.join(dir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const fm = parsed.data as PostFrontMatter;
      if (fm.id === id) {
        if (sub === "published") pubCache.set(id, filePath);
        return filePath;
      }
    }
  }

  return null;
}

function writePostFile(
  filePath: string,
  frontMatter: PostFrontMatter,
  content: string
): void {
  const cleanFm: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontMatter)) {
    if (value !== undefined) {
      cleanFm[key] = value;
    }
  }

  // English posts don't need *En supplements — strip them if present
  if (frontMatter.language === "en") {
    delete cleanFm.titleEn;
    delete cleanFm.tagsEn;
    delete cleanFm.metaDescriptionEn;
  }

  const output = matter.stringify(trimBlankLines(content), cleanFm);
  fs.writeFileSync(filePath, output);
}

/**
 * Loads all post summaries from a subdirectory.
 */
function loadAllSummaries(subdir: string): PostSummary[] {
  const dir = path.join(postsDir, subdir);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  const summaries: PostSummary[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      summaries.push({ frontMatter: parsed.data as PostFrontMatter });
    } catch (err) {
      logWarn(`Skipping malformed ${subdir} file: ${filePath} — ${err instanceof Error ? err.message : err}`);
    }
  }

  // Most recently edited first
  summaries.sort((a, b) => {
    const ta = a.frontMatter.updatedAtUtc ?? a.frontMatter.createdAtUtc ?? "";
    const tb = b.frontMatter.updatedAtUtc ?? b.frontMatter.createdAtUtc ?? "";
    return tb.localeCompare(ta);
  });

  return summaries;
}
