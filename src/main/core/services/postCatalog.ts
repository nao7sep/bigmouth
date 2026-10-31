/**
 * The posts of each open workspace, as their files list themselves
 * (data-lifecycle-conventions, Items list and sort themselves).
 *
 * The first read of a workspace reads the front matter of every `posts/*.md`
 * into memory, and the app's own writes keep that list current (`upsertEntry`,
 * `upsertEntries`, `removeEntry`). Nothing is stored beside the post files: the
 * Markdown files are the only authority. A file edited outside the app is seen
 * when the workspace is next opened or its posts are reread from Settings.
 */

import fs from "node:fs";
import path from "node:path";
import type { PostStatus, PostListEntry } from "../shared/types.js";
import type { UnreadablePostFile } from "@shared/types";
import { readPost, projectListEntry } from "./postFile.js";
import { NewerFormatError } from "../shared/storeFormat.js";
import { serializeError, warn as logWarn } from "./logger.js";
import { isPostStatus } from "../shared/postLifecycle.js";
import { isPostId } from "../shared/filenames.js";

interface Catalog {
  /** Readable posts by id; the first file in name order keeps an id. */
  posts: Map<string, PostListEntry>;
  /** Files whose front matter could not be read, shown as damaged with their path. */
  unreadable: UnreadablePostFile[];
}

const catalogs = new Map<string, Catalog>();

function postsDir(dataDir: string): string {
  return path.join(dataDir, "posts");
}

// --- Public API ---

export function clearCache(dataDir: string): void {
  catalogs.delete(dataDir);
}

export function getEntry(dataDir: string, id: string): PostListEntry | null {
  return catalog(dataDir).posts.get(id) ?? null;
}

export function allEntries(dataDir: string): PostListEntry[] {
  return [...catalog(dataDir).posts.values()];
}

export function listByStatus(dataDir: string, status: PostStatus): PostListEntry[] {
  return allEntries(dataDir).filter((entry) => entry.status === status);
}

export function countByStatus(dataDir: string, status: PostStatus): number {
  let count = 0;
  for (const entry of catalog(dataDir).posts.values()) {
    if (entry.status === status) count++;
  }
  return count;
}

/** Records a post the app wrote. */
export function upsertEntry(dataDir: string, entry: PostListEntry): void {
  upsertEntries(dataDir, [entry]);
}

/** Records posts the app wrote in one bulk change. */
export function upsertEntries(dataDir: string, entries: readonly PostListEntry[]): void {
  const { posts } = catalog(dataDir);
  for (const entry of entries) posts.set(entry.id, entry);
}

/** Forgets a post the app deleted. */
export function removeEntry(dataDir: string, id: string): void {
  catalog(dataDir).posts.delete(id);
}

/** The post files the last read could not use. */
export function unreadableFiles(dataDir: string): UnreadablePostFile[] {
  return [...catalog(dataDir).unreadable];
}

export interface DuplicateSlugGroup {
  slug: string;
  fileNames: string[];
}

/** What a reread found: listed posts, unusable files, and ambiguous slugs. */
export interface RereadResult {
  listed: number;
  skipped: { fileName: string; reason: string }[];
  duplicateSlugs: DuplicateSlugGroup[];
}

/**
 * Reads every post file again, as opening the workspace does, and reports what
 * it left out as well as what it listed: a post hand-edited into something
 * unreadable must not vanish under a success message.
 */
export function reread(dataDir: string): RereadResult {
  const { read, skipped } = readFromFiles(dataDir);
  catalogs.set(dataDir, read);
  const duplicateSlugs = findDuplicateSlugGroups(read.posts.values());
  for (const duplicate of duplicateSlugs) {
    logWarn("duplicate post slug", { dataDirectory: dataDir, slug: duplicate.slug, fileNames: duplicate.fileNames });
  }
  return { listed: read.posts.size, skipped, duplicateSlugs };
}

/**
 * Paths of the post files sharing `id`, when there is more than one, as the
 * files are now. Work that deletes or replaces a post's attachments checks this
 * first, since a copy made outside the app after the list was read would share
 * them. Only files whose text names the id have their front matter read.
 */
export function duplicateFiles(dataDir: string, id: string): string[] {
  const files: string[] = [];
  for (const fileName of postFileNames(dataDir)) {
    const filePath = path.join(postsDir(dataDir), fileName);
    try {
      if (!fs.readFileSync(filePath, "utf-8").includes(id)) continue;
      if (readPost(filePath).frontMatter.id === id) files.push(filePath);
    } catch {
      // A file that cannot be read claims no id; the list reports it as damaged.
    }
  }
  return files.length > 1 ? files : [];
}

// --- Internal ---

function catalog(dataDir: string): Catalog {
  let found = catalogs.get(dataDir);
  if (!found) {
    found = readFromFiles(dataDir).read;
    catalogs.set(dataDir, found);
  }
  return found;
}

function readFromFiles(dataDir: string): { read: Catalog; skipped: { fileName: string; reason: string }[] } {
  const read: Catalog = { posts: new Map(), unreadable: [] };
  const skipped: { fileName: string; reason: string }[] = [];
  for (const fileName of postFileNames(dataDir)) {
    const result = entryFromFile(dataDir, fileName);
    if ("reason" in result) {
      skipped.push({ fileName, reason: result.reason });
      read.unreadable.push({ path: path.join(postsDir(dataDir), fileName), newer: result.newer });
      continue;
    }
    const kept = read.posts.get(result.entry.id);
    if (kept) {
      // The first file in name order keeps the id; a copy is logged, never listed over it.
      logWarn("post file skipped: duplicate id", { dataDirectory: dataDir, id: result.entry.id, kept: kept.fileName, ignored: fileName });
      skipped.push({ fileName, reason: `duplicate post id ${result.entry.id}` });
      continue;
    }
    read.posts.set(result.entry.id, result.entry);
  }
  return { read, skipped };
}

/**
 * Reads one post file into its list entry, or says why it cannot be listed:
 * unreadable, malformed front matter, no id, or a status outside the five. A
 * bad file is reported, never thrown, so one damaged post leaves the rest of
 * the workspace working (store-recovery-conventions).
 */
function entryFromFile(
  dataDir: string,
  fileName: string,
): { entry: PostListEntry } | { reason: string; newer: boolean } {
  const skip = (reason: string) => {
    logWarn("post file skipped", { dataDirectory: dataDir, fileName, reason });
    return { reason, newer: false };
  };
  try {
    const post = readPost(path.join(postsDir(dataDir), fileName));
    if (!post.frontMatter.id) return skip("no id in its front matter");
    // The id names the post's asset folder, so one outside the grammar (`..`,
    // `.`, a path) never becomes a post the app could delete or upload through.
    if (!isPostId(post.frontMatter.id)) return skip(`invalid post id ${JSON.stringify(post.frontMatter.id)}`);
    // A status outside the five reaches no list section.
    if (!isPostStatus(post.frontMatter.status)) return skip(`unknown status ${JSON.stringify(post.frontMatter.status)}`);
    return { entry: projectListEntry(post.frontMatter, fileName, post.content) };
  } catch (err) {
    // `reason` is what the user is shown; the serialized error is what makes the
    // line diagnosable, and the two are not interchangeable.
    const reason = err instanceof Error ? err.message : String(err);
    logWarn("post file skipped", { dataDirectory: dataDir, fileName, reason, error: serializeError(err) });
    return { reason, newer: err instanceof NewerFormatError };
  }
}

function postFileNames(dataDir: string): string[] {
  const dir = postsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

function findDuplicateSlugGroups(entries: Iterable<PostListEntry>): DuplicateSlugGroup[] {
  const bySlug = new Map<string, DuplicateSlugGroup>();
  for (const entry of entries) {
    if (!entry.slug) continue;
    const key = entry.slug.toLowerCase();
    const existing = bySlug.get(key);
    if (existing) {
      existing.fileNames.push(entry.fileName);
    } else {
      bySlug.set(key, { slug: key, fileNames: [entry.fileName] });
    }
  }
  return [...bySlug.values()].filter((group) => group.fileNames.length > 1);
}
