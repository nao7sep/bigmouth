/**
 * Post file format and single-file I/O.
 *
 * Owns everything about reading and writing one `.md` post file: front-matter
 * parsing, canonical serialization, atomic writes, and the projection of a post
 * into its index entry. Knows nothing about the index or the post store, so it
 * sits below both of them with no cycles.
 */

import fs from "node:fs";
import matter from "gray-matter";
import type { Post, PostFrontMatter, PostIndexEntry } from "../shared/types.js";
import { multiline, truncate } from "../shared/textCleanup.js";
import { writeFileAtomic } from "../shared/atomicWrite.js";

// Length, in graphemes, of a body-derived preview label for an untitled post.
const EXCERPT_MAX_CHARS = 100;

// Markdown bodies use two trailing spaces as a hard line break, so the body
// normalization keeps line ends and only drops blank lines at the edges. This
// matches the old behavior, which also dropped only leading and trailing blanks.
const BODY_MULTILINE_OPTS = {
  trimLineEnds: false,
  dropEdgeBlankLines: true,
  collapseBlankLines: false,
} as const;

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
  return { frontMatter, content: multiline(parsed.content, BODY_MULTILINE_OPTS) };
}

export function readPost(filePath: string): Post {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { frontMatter, content } = parsePostRaw(raw);
  return { frontMatter, content, filePath };
}

export function writePost(filePath: string, frontMatter: PostFrontMatter, content: string): void {
  const cleanFm = canonicalizeFrontMatter(frontMatter);
  const output = matter.stringify(multiline(content, BODY_MULTILINE_OPTS), cleanFm);
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
    const excerpt = truncate(body, EXCERPT_MAX_CHARS).text;
    if (excerpt) entry.excerpt = excerpt;
  }
  if (Array.isArray(frontMatter.tags) && frontMatter.tags.length > 0) entry.tags = frontMatter.tags;
  if (frontMatter.sourceId) entry.sourceId = frontMatter.sourceId;
  if (frontMatter.checkedAtUtc) entry.checkedAtUtc = frontMatter.checkedAtUtc;
  if (frontMatter.publishedAtUtc) entry.publishedAtUtc = frontMatter.publishedAtUtc;
  return entry;
}

