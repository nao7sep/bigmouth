/**
 * Post file format and single-file I/O.
 *
 * Owns everything about reading and writing one `.md` post file: front-matter
 * parsing, canonical serialization, atomic writes, and the projection of a post
 * into its index entry. Knows nothing about the index or the post store, so it
 * sits below both of them with no cycles.
 */

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { Post, PostFrontMatter, PostIndexEntry } from "../shared/types.js";
import { minifyExcerpt } from "../shared/text.js";

// Canonical front-matter key order written into every `.md` file. Keeping a
// fixed order makes files stable across rewrites and easy to diff.
const CANONICAL_KEYS = [
  "id",
  "target",
  "status",
  "language",
  "sourceId",
  "title",
  "titleEn",
  "slug",
  "tags",
  "tagsEn",
  "metaDescription",
  "metaDescriptionEn",
  "extra",
  "createdAtUtc",
  "updatedAtUtc",
  "checkedAtUtc",
  "publishedAtUtc",
] as const;

const CANONICAL_KEY_SET = new Set<string>(CANONICAL_KEYS);

/**
 * Parses raw file text into an owned front matter object and trimmed content.
 *
 * gray-matter caches parsed results by input string, so `parsed.data` is a
 * shared reference; we deep-clone it so callers own their copy and can mutate
 * it without corrupting another reader of an identical file.
 */
export function parsePostRaw(raw: string): { frontMatter: PostFrontMatter; content: string } {
  const parsed = matter(raw);
  const frontMatter = structuredClone(parsed.data) as PostFrontMatter;
  return { frontMatter, content: trimBlankLines(parsed.content) };
}

export function readPost(filePath: string): Post {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { frontMatter, content } = parsePostRaw(raw);
  return { frontMatter, content, filePath };
}

export function writePost(filePath: string, frontMatter: PostFrontMatter, content: string): void {
  const cleanFm = canonicalizeFrontMatter(frontMatter);
  const output = matter.stringify(trimBlankLines(content), cleanFm);
  writeFileAtomic(filePath, output);
}

/**
 * Returns front matter with keys in canonical order and English supplement
 * fields stripped for English posts. Unknown keys are preserved (after the
 * known ones) so hand-added front matter survives a rewrite.
 */
export function canonicalizeFrontMatter(frontMatter: PostFrontMatter): Record<string, unknown> {
  const cleanFm: Record<string, unknown> = {};
  for (const key of CANONICAL_KEYS) {
    const value = frontMatter[key];
    if (value !== undefined) cleanFm[key] = value;
  }

  if (frontMatter.language === "en") {
    delete cleanFm.titleEn;
    delete cleanFm.tagsEn;
    delete cleanFm.metaDescriptionEn;
  }

  // Preserve any unknown extra front matter keys. Known keys are already handled
  // above (including the deliberate *En strip for en posts), so they must not be
  // re-added here — otherwise stripped fields would reappear.
  for (const [key, value] of Object.entries(frontMatter)) {
    if (CANONICAL_KEY_SET.has(key)) continue;
    if (!(key in cleanFm) && value !== undefined) cleanFm[key] = value;
  }

  return cleanFm;
}

/**
 * Projects a post's front matter into its index entry. Mirrors the *En strip so
 * an English post never carries a titleEn into the index.
 *
 * When the post has neither a title nor a titleEn, a body-derived `excerpt` is
 * stored so the list can show a meaningful label instead of the post id. Titled
 * posts carry no excerpt, so editing their body never churns the index.
 */
export function projectIndexEntry(
  frontMatter: PostFrontMatter,
  fileName: string,
  body: string
): PostIndexEntry {
  const entry: PostIndexEntry = {
    id: frontMatter.id,
    fileName,
    status: frontMatter.status,
    target: frontMatter.target,
    language: frontMatter.language,
    createdAtUtc: frontMatter.createdAtUtc,
  };
  if (frontMatter.slug) entry.slug = frontMatter.slug;
  if (frontMatter.title) entry.title = frontMatter.title;
  if (frontMatter.language !== "en" && frontMatter.titleEn) entry.titleEn = frontMatter.titleEn;
  if (!entry.title && !entry.titleEn) {
    const excerpt = minifyExcerpt(body);
    if (excerpt) entry.excerpt = excerpt;
  }
  if (Array.isArray(frontMatter.tags) && frontMatter.tags.length > 0) entry.tags = frontMatter.tags;
  if (frontMatter.sourceId) entry.sourceId = frontMatter.sourceId;
  if (frontMatter.checkedAtUtc) entry.checkedAtUtc = frontMatter.checkedAtUtc;
  if (frontMatter.publishedAtUtc) entry.publishedAtUtc = frontMatter.publishedAtUtc;
  return entry;
}

/**
 * Trims leading and trailing blank lines, preserving interior ones.
 */
export function trimBlankLines(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  let end = lines.length - 1;
  while (end >= start && lines[end].trim() === "") end--;
  return start > end ? "" : lines.slice(start, end + 1).join("\n");
}

/**
 * Writes a file atomically: write a sibling temp file, then rename over the
 * target. A crash mid-write leaves either the old file or the new one, never a
 * truncated one.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${nextTempCounter()}.tmp`);
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

// A per-process counter keeps concurrent atomic writes from colliding on the
// temp filename without relying on Date.now()/Math.random().
let tempCounter = 0;
function nextTempCounter(): number {
  tempCounter += 1;
  return tempCounter;
}
