/**
 * Post filename generation.
 *
 * Every post lives in a single `posts/` directory under a name that is fixed
 * for the post's entire lifetime:
 *
 *   posts/{createdAtUtc}-{nanoid}.md   e.g. 20260405-143022-utc-V1StGXR8_Z5jD.md
 *
 * The name is computed once at creation and never recomputed, so a status
 * change, slug change, or content edit never moves or renames the file — the
 * change shows up as an in-place diff. The timestamp prefix keeps the directory
 * (and git diffs) in creation order; the nanoid guarantees uniqueness.
 */

import { formatForFilename } from "./timestamps.js";

export function postFileName(createdAtUtc: Date, id: string): string {
  return `${formatForFilename(createdAtUtc)}-${id}.md`;
}

// A post id is a nanoid. It names the post's file and its `assets/<id>/`
// folder, and the app lets the user hand-edit post files, so an id read from
// disk is untrusted: `.`, `..` or a separator would turn the asset folder into
// a path outside `assets/`. This grammar is the one gate, applied where a file
// becomes an index entry and again where an id becomes a path.
const POST_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isPostId(value: unknown): value is string {
  return typeof value === "string" && POST_ID_RE.test(value);
}
