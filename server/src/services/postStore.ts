/**
 * Post file I/O layer.
 *
 * Posts are stored in subdirectories by status:
 *   posts/drafts/      — all loaded on startup (always small)
 *   posts/ready/       — all loaded on startup (always small)
 *   posts/published/   — loaded in batches by filename sort (grows over time)
 *
 * All public functions take a dataDir parameter (the workspace data directory).
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

// Published post cache: maps workspaceId -> postId -> absolute file path.
// Populated as published posts are accessed; evicted on delete or unpublish.
const pubCaches = new Map<string, Map<string, string>>();

function pubCache(dataDir: string): Map<string, string> {
  let cache = pubCaches.get(dataDir);
  if (!cache) {
    cache = new Map();
    pubCaches.set(dataDir, cache);
  }
  return cache;
}

export function clearCache(dataDir: string): void {
  pubCaches.delete(dataDir);
}

function postsDir(dataDir: string): string {
  return path.join(dataDir, "posts");
}

// --- List ---

export function listDrafts(dataDir: string): PostSummary[] {
  return loadAllSummaries(dataDir, "drafts");
}

export function listReady(dataDir: string): PostSummary[] {
  return loadAllSummaries(dataDir, "ready");
}

export function listPublished(dataDir: string, offset: number, limit: number): PostSummary[] {
  const dir = path.join(postsDir(dataDir), "published");
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();

  const cache = pubCache(dataDir);
  const summaries: PostSummary[] = [];
  for (const file of files.slice(offset, offset + limit)) {
    const filePath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const fm = parsed.data as PostFrontMatter;
      if (fm.id) cache.set(fm.id, filePath);
      summaries.push({ frontMatter: fm });
    } catch (err) {
      logWarn(`Skipping malformed published file: ${filePath} — ${err instanceof Error ? err.message : err}`);
    }
  }

  return summaries;
}

export function countPublished(dataDir: string): number {
  const dir = path.join(postsDir(dataDir), "published");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
}

// --- Read ---

export function getPost(dataDir: string, id: string): Post | null {
  const filePath = findPostFile(dataDir, id);
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

export function createPost(dataDir: string, target: string, language: string, sourceId?: string): Post {
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
  const filePath = path.join(postsDir(dataDir), "drafts", fileName);

  writePostFile(filePath, frontMatter, "");

  return { frontMatter, content: "", filePath };
}

// --- Update ---

export function updatePost(
  dataDir: string,
  id: string,
  updates: {
    content?: string;
    frontMatter?: Partial<PostFrontMatter>;
  }
): Post | null {
  const post = getPost(dataDir, id);
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
    const newFilePath = path.join(postsDir(dataDir), "published", buildFilename(post.frontMatter));
    writePostFile(newFilePath, post.frontMatter, post.content);
    if (newFilePath !== post.filePath) {
      fs.unlinkSync(post.filePath);
      post.filePath = newFilePath;
    }
    pubCache(dataDir).set(id, post.filePath);
  } else {
    writePostFile(post.filePath, post.frontMatter, post.content);
  }

  return post;
}

// --- Status change ---

export function changeStatus(dataDir: string, id: string, newStatus: PostStatus): Post | null {
  const post = getPost(dataDir, id);
  if (!post) return null;

  const oldStatus = post.frontMatter.status;
  if (oldStatus === newStatus) return post;

  const now = utcNow();
  const oldFilePath = post.filePath;

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

  const newFileName = buildFilename(post.frontMatter);
  const newFilePath = path.join(
    postsDir(dataDir),
    statusSubdir(newStatus),
    newFileName
  );

  writePostFile(newFilePath, post.frontMatter, post.content);
  if (newFilePath !== oldFilePath) {
    fs.unlinkSync(oldFilePath);
  }

  const cache = pubCache(dataDir);
  if (newStatus === "published") {
    cache.set(id, newFilePath);
  } else if (oldStatus === "published") {
    cache.delete(id);
  }

  post.filePath = newFilePath;
  return post;
}

// --- Delete ---

export function deletePost(dataDir: string, id: string): boolean {
  const filePath = findPostFile(dataDir, id);
  if (!filePath) return false;

  fs.unlinkSync(filePath);
  pubCache(dataDir).delete(id);

  const assetDir = path.join(dataDir, "assets", id);
  if (fs.existsSync(assetDir)) {
    fs.rmSync(assetDir, { recursive: true });
  }

  return true;
}

// --- Target rename ---

export function renameTarget(dataDir: string, oldName: string, newName: string): number {
  let count = 0;
  for (const sub of ["drafts", "ready", "published"]) {
    const dir = path.join(postsDir(dataDir), sub);
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

function buildFilename(fm: PostFrontMatter): string {
  if (fm.status === "draft") {
    return draftFilename(new Date(fm.createdAtUtc), fm.id);
  }
  if (fm.status === "ready") {
    return readyFilename(new Date(fm.readyAtUtc!), fm.slug!);
  }
  return publishedFilename(new Date(fm.publishedAtUtc!), fm.slug!);
}

function findPostFile(dataDir: string, id: string): string | null {
  const cache = pubCache(dataDir);
  const cached = cache.get(id);
  if (cached) {
    if (fs.existsSync(cached)) return cached;
    cache.delete(id);
  }

  const pDir = postsDir(dataDir);
  for (const sub of ["drafts", "ready", "published"]) {
    const dir = path.join(pDir, sub);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));

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

    for (const file of files) {
      if (sub !== "published" && file.includes(id)) continue;
      const filePath = path.join(dir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const fm = parsed.data as PostFrontMatter;
      if (fm.id === id) {
        if (sub === "published") cache.set(id, filePath);
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

  if (frontMatter.language === "en") {
    delete cleanFm.titleEn;
    delete cleanFm.tagsEn;
    delete cleanFm.metaDescriptionEn;
  }

  const output = matter.stringify(trimBlankLines(content), cleanFm);
  fs.writeFileSync(filePath, output);
}

function loadAllSummaries(dataDir: string, subdir: string): PostSummary[] {
  const dir = path.join(postsDir(dataDir), subdir);
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

  summaries.sort((a, b) => {
    const ta = a.frontMatter.updatedAtUtc ?? a.frontMatter.createdAtUtc ?? "";
    const tb = b.frontMatter.updatedAtUtc ?? b.frontMatter.createdAtUtc ?? "";
    return tb.localeCompare(ta);
  });

  return summaries;
}
