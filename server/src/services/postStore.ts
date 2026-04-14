/**
 * Post file I/O layer.
 *
 * Posts are stored in subdirectories by status:
 *   posts/drafts/      — summaries cached in memory per workspace
 *   posts/ready/       — summaries cached in memory per workspace
 *   posts/published/   — summaries cached in memory per workspace
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

interface IndexedPost {
  frontMatter: PostFrontMatter;
  filePath: string;
}

interface SummaryIndex {
  byId: Map<string, IndexedPost>;
  drafts: string[];
  ready: string[];
  published: string[];
}

const summaryIndexes = new Map<string, SummaryIndex>();

export function clearCache(dataDir: string): void {
  summaryIndexes.delete(dataDir);
}

function postsDir(dataDir: string): string {
  return path.join(dataDir, "posts");
}

// --- List ---

export function listDrafts(dataDir: string): PostSummary[] {
  return listSummaries(dataDir, "draft");
}

export function listReady(dataDir: string): PostSummary[] {
  return listSummaries(dataDir, "ready");
}

export function listPublished(dataDir: string, offset: number, limit: number): PostSummary[] {
  return listSummaries(dataDir, "published").slice(offset, offset + limit);
}

export function countPublished(dataDir: string): number {
  return summaryIndex(dataDir).published.length;
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
  upsertSummary(dataDir, { frontMatter, content: "", filePath });

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
  } else {
    writePostFile(post.filePath, post.frontMatter, post.content);
  }

  upsertSummary(dataDir, post);
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

  post.filePath = newFilePath;
  upsertSummary(dataDir, post);
  return post;
}

// --- Delete ---

export function deletePost(dataDir: string, id: string): boolean {
  const filePath = findPostFile(dataDir, id);
  if (!filePath) return false;

  fs.unlinkSync(filePath);
  removeSummary(dataDir, id);

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
  if (count > 0) clearCache(dataDir);
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
  const indexed = summaryIndex(dataDir).byId.get(id);
  if (indexed && fs.existsSync(indexed.filePath)) return indexed.filePath;
  if (indexed) {
    clearCache(dataDir);
    return summaryIndex(dataDir).byId.get(id)?.filePath ?? null;
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

function summaryIndex(dataDir: string): SummaryIndex {
  let index = summaryIndexes.get(dataDir);
  if (!index) {
    index = buildSummaryIndex(dataDir);
    summaryIndexes.set(dataDir, index);
  }
  return index;
}

function buildSummaryIndex(dataDir: string): SummaryIndex {
  const index: SummaryIndex = {
    byId: new Map(),
    drafts: [],
    ready: [],
    published: [],
  };

  loadStatusEntries(dataDir, "drafts", index);
  loadStatusEntries(dataDir, "ready", index);
  loadStatusEntries(dataDir, "published", index);

  sortStatusIds(index, "draft");
  sortStatusIds(index, "ready");
  sortStatusIds(index, "published");

  return index;
}

function loadStatusEntries(
  dataDir: string,
  subdir: "drafts" | "ready" | "published",
  index: SummaryIndex
): void {
  const dir = path.join(postsDir(dataDir), subdir);
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  const ids = idsForSubdir(index, subdir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const frontMatter = parsed.data as PostFrontMatter;
      if (!frontMatter.id) {
        logWarn(`Skipping ${subdir} file without id: ${filePath}`);
        continue;
      }
      index.byId.set(frontMatter.id, { frontMatter, filePath });
      ids.push(frontMatter.id);
    } catch (err) {
      logWarn(`Skipping malformed ${subdir} file: ${filePath} — ${err instanceof Error ? err.message : err}`);
    }
  }
}

function listSummaries(dataDir: string, status: PostStatus): PostSummary[] {
  const index = summaryIndex(dataDir);
  return idsForStatus(index, status)
    .map((id) => index.byId.get(id))
    .filter((entry): entry is IndexedPost => Boolean(entry))
    .map((entry) => ({ frontMatter: entry.frontMatter }));
}

function upsertSummary(dataDir: string, post: Post): void {
  const index = summaryIndex(dataDir);
  const id = post.frontMatter.id;
  removeIdFromLists(index, id);
  index.byId.set(id, {
    frontMatter: { ...post.frontMatter },
    filePath: post.filePath,
  });
  idsForStatus(index, post.frontMatter.status).push(id);
  sortStatusIds(index, post.frontMatter.status);
}

function removeSummary(dataDir: string, id: string): void {
  const index = summaryIndex(dataDir);
  removeIdFromLists(index, id);
  index.byId.delete(id);
}

function removeIdFromLists(index: SummaryIndex, id: string): void {
  index.drafts = index.drafts.filter((entryId) => entryId !== id);
  index.ready = index.ready.filter((entryId) => entryId !== id);
  index.published = index.published.filter((entryId) => entryId !== id);
}

function sortStatusIds(index: SummaryIndex, status: PostStatus): void {
  idsForStatus(index, status).sort((a, b) => compareIndexedPosts(index, status, a, b));
}

function compareIndexedPosts(
  index: SummaryIndex,
  status: PostStatus,
  aId: string,
  bId: string
): number {
  const a = index.byId.get(aId);
  const b = index.byId.get(bId);
  if (!a || !b) return 0;

  if (status === "published") {
    return path.basename(b.filePath).localeCompare(path.basename(a.filePath));
  }

  const aTime = a.frontMatter.updatedAtUtc ?? a.frontMatter.createdAtUtc ?? "";
  const bTime = b.frontMatter.updatedAtUtc ?? b.frontMatter.createdAtUtc ?? "";
  return bTime.localeCompare(aTime);
}

function idsForStatus(index: SummaryIndex, status: PostStatus): string[] {
  if (status === "draft") return index.drafts;
  if (status === "ready") return index.ready;
  return index.published;
}

function idsForSubdir(index: SummaryIndex, subdir: "drafts" | "ready" | "published"): string[] {
  if (subdir === "drafts") return index.drafts;
  if (subdir === "ready") return index.ready;
  return index.published;
}
