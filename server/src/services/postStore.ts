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
import {
  draftFilename,
  readyFilename,
  publishedFilename,
  statusSubdir,
} from "../shared/filenames.js";

let postsDir = "";
let dataDir = "";

export function initPostStore(dataDirectory: string): void {
  dataDir = dataDirectory;
  postsDir = path.join(dataDirectory, "posts");
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
 */
export function listPublished(offset: number, limit: number): PostSummary[] {
  const dir = path.join(postsDir, "published");
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse(); // newest first by filename (publishedAtUtc)

  const batch = files.slice(offset, offset + limit);
  const summaries: PostSummary[] = [];

  for (const file of batch) {
    const filePath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      summaries.push({ frontMatter: parsed.data as PostFrontMatter });
    } catch {
      // Skip malformed files
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
    content: parsed.content,
    filePath,
  };
}

// --- Create ---

export function createPost(target: string, language: string): Post {
  const now = utcNow();
  const id = nanoid();

  const frontMatter: PostFrontMatter = {
    id,
    target,
    status: "draft",
    language,
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
    Object.assign(post.frontMatter, updates.frontMatter);
  }
  post.frontMatter.updatedAtUtc = formatForFrontMatter(utcNow());

  if (updates.content !== undefined) {
    post.content = updates.content;
  }

  // Protect immutable fields
  post.frontMatter.id = id;

  writePostFile(post.filePath, post.frontMatter, post.content);

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

  post.filePath = newFilePath;
  return post;
}

// --- Delete ---

export function deletePost(id: string): boolean {
  const filePath = findPostFile(id);
  if (!filePath) return false;

  fs.unlinkSync(filePath);

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
 * Finds the file path of a post by scanning subdirectories.
 * Checks drafts first (nanoid is in the filename), then ready and published.
 */
function findPostFile(id: string): string | null {
  for (const sub of ["drafts", "ready", "published"]) {
    const dir = path.join(postsDir, sub);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));

    // Quick check: drafts have nanoid in filename
    for (const file of files) {
      if (file.includes(id)) {
        const filePath = path.join(dir, file);
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = matter(raw);
        if ((parsed.data as PostFrontMatter).id === id) {
          return filePath;
        }
      }
    }

    // Fallback: parse all files in this subdir
    for (const file of files) {
      if (file.includes(id)) continue; // already checked
      const filePath = path.join(dir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      if ((parsed.data as PostFrontMatter).id === id) {
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

  const output = matter.stringify(content, cleanFm);
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
    } catch {
      // Skip malformed files
    }
  }

  return summaries;
}
