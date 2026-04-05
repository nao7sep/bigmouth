/**
 * Post file I/O layer.
 *
 * Each post is a Markdown file with YAML front matter, stored in {dataDirectory}/posts/.
 * This module handles reading, writing, listing, deleting, and renaming post files.
 */

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { nanoid } from "nanoid";
import type { Post, PostFrontMatter, PostSummary, PostStatus } from "../shared/types.js";
import { utcNow, formatForFrontMatter } from "../shared/timestamps.js";
import { postFilename, draftFilename } from "../shared/filenames.js";

let postsDir = "";

/**
 * Must be called once at startup with the resolved data directory.
 */
export function initPostStore(dataDirectory: string): void {
  postsDir = path.join(dataDirectory, "posts");
}

/**
 * Lists all posts (front matter only, no content) from the posts directory.
 */
export function listPosts(): PostSummary[] {
  const files = fs.readdirSync(postsDir).filter((f) => f.endsWith(".md"));
  const summaries: PostSummary[] = [];

  for (const file of files) {
    const filePath = path.join(postsDir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      summaries.push({
        frontMatter: parsed.data as PostFrontMatter,
      });
    } catch {
      // Skip malformed files — logged elsewhere if needed
    }
  }

  return summaries;
}

/**
 * Reads a single post by its nanoid.
 * Returns null if not found.
 */
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

/**
 * Creates a new draft post. Returns the created post.
 */
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
  const filePath = path.join(postsDir, fileName);
  const content = "";

  writePostFile(filePath, frontMatter, content);

  return { frontMatter, content, filePath };
}

/**
 * Updates a post's content and/or front matter fields.
 * Always updates updatedAtUtc.
 */
export function updatePost(
  id: string,
  updates: {
    content?: string;
    frontMatter?: Partial<PostFrontMatter>;
  }
): Post | null {
  const post = getPost(id);
  if (!post) return null;

  const now = utcNow();

  // Merge front matter updates
  if (updates.frontMatter) {
    Object.assign(post.frontMatter, updates.frontMatter);
  }
  post.frontMatter.updatedAtUtc = formatForFrontMatter(now);

  // Update content if provided
  if (updates.content !== undefined) {
    post.content = updates.content;
  }

  // id, status, and timestamps managed by the app — don't allow overwriting
  post.frontMatter.id = id;

  writePostFile(post.filePath, post.frontMatter, post.content);

  return post;
}

/**
 * Changes a post's status. Handles timestamp updates and file renames.
 *
 * Transitions:
 *   draft -> ready:     sets readyAtUtc, renames to {readyAtUtc}-{slug}.md
 *   ready -> published: sets publishedAtUtc
 *   published -> ready: clears publishedAtUtc, preserves readyAtUtc, no rename
 *   ready -> draft:     clears readyAtUtc, renames to {createdAtUtc}-{nanoid}.md
 *   published -> draft: clears readyAtUtc and publishedAtUtc, renames to {createdAtUtc}-{nanoid}.md
 */
export function changeStatus(
  id: string,
  newStatus: PostStatus
): Post | null {
  const post = getPost(id);
  if (!post) return null;

  const oldStatus = post.frontMatter.status;
  if (oldStatus === newStatus) return post;

  const now = utcNow();
  const oldFilePath = post.filePath;

  // Apply status transition logic
  if (newStatus === "ready") {
    if (!post.frontMatter.slug) {
      throw new Error("Slug is required to move a post to ready status");
    }
    if (!post.frontMatter.readyAtUtc) {
      post.frontMatter.readyAtUtc = formatForFrontMatter(now);
    }
    post.frontMatter.publishedAtUtc = undefined;
  } else if (newStatus === "published") {
    post.frontMatter.publishedAtUtc = formatForFrontMatter(now);
  } else if (newStatus === "draft") {
    post.frontMatter.readyAtUtc = undefined;
    post.frontMatter.publishedAtUtc = undefined;
  }

  post.frontMatter.status = newStatus;
  post.frontMatter.updatedAtUtc = formatForFrontMatter(now);

  // Determine new filename
  const newFileName = postFilename(
    newStatus,
    new Date(post.frontMatter.createdAtUtc),
    post.frontMatter.id,
    post.frontMatter.readyAtUtc
      ? new Date(post.frontMatter.readyAtUtc)
      : undefined,
    post.frontMatter.slug
  );
  const newFilePath = path.join(postsDir, newFileName);

  // Write to new path, delete old if path changed
  writePostFile(newFilePath, post.frontMatter, post.content);
  if (newFilePath !== oldFilePath) {
    fs.unlinkSync(oldFilePath);
  }

  post.filePath = newFilePath;
  return post;
}

/**
 * Deletes a post and its asset directory.
 */
export function deletePost(id: string, dataDirectory: string): boolean {
  const filePath = findPostFile(id);
  if (!filePath) return false;

  fs.unlinkSync(filePath);

  // Also delete asset directory if it exists
  const assetDir = path.join(dataDirectory, "assets", id);
  if (fs.existsSync(assetDir)) {
    fs.rmSync(assetDir, { recursive: true });
  }

  return true;
}

/**
 * Renames a target across all post files.
 * Returns the number of posts updated.
 */
export function renameTarget(oldName: string, newName: string): number {
  const files = fs.readdirSync(postsDir).filter((f) => f.endsWith(".md"));
  let count = 0;

  for (const file of files) {
    const filePath = path.join(postsDir, file);
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(raw);
    const fm = parsed.data as PostFrontMatter;

    if (fm.target === oldName) {
      fm.target = newName;
      writePostFile(filePath, fm, parsed.content);
      count++;
    }
  }

  return count;
}

// --- Internal helpers ---

/**
 * Finds the file path of a post by scanning all .md files for a matching id.
 */
function findPostFile(id: string): string | null {
  const files = fs.readdirSync(postsDir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    // Quick check: draft filenames end with the nanoid
    if (file.includes(id)) {
      const filePath = path.join(postsDir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      if ((parsed.data as PostFrontMatter).id === id) {
        return filePath;
      }
    }
  }

  // Fallback: scan all files (for ready/published where nanoid is not in filename)
  for (const file of files) {
    if (file.includes(id)) continue; // already checked
    const filePath = path.join(postsDir, file);
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(raw);
    if ((parsed.data as PostFrontMatter).id === id) {
      return filePath;
    }
  }

  return null;
}

/**
 * Writes a post file with YAML front matter and Markdown content.
 */
function writePostFile(
  filePath: string,
  frontMatter: PostFrontMatter,
  content: string
): void {
  // Clean up undefined values so they don't appear in YAML
  const cleanFm: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontMatter)) {
    if (value !== undefined) {
      cleanFm[key] = value;
    }
  }

  const output = matter.stringify(content, cleanFm);
  fs.writeFileSync(filePath, output);
}
