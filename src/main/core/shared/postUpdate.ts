import type { PostStatus } from "@shared/types";

import { isEditLocked } from "./postLifecycle.js";
import type { EditablePostMetadata } from "./types.js";

// Slug must be safe for export filenames and URLs: ASCII alphanumerics, hyphens,
// and underscores only.
const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

const EDITABLE_FRONT_MATTER_KEYS = [
  "target",
  "language",
  "title",
  "titleEn",
  "slug",
  "tags",
  "tagsEn",
  "metaDescription",
  "metaDescriptionEn",
  "extra",
  "sourceId",
] as const;

const RESERVED_FRONT_MATTER_KEYS = new Set([
  "id",
  "status",
  "createdAtUtc",
  "updatedAtUtc",
  "readyAtUtc",
  "publishedAtUtc",
  "expiredAtUtc",
]);

export function validateSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return SLUG_RE.test(value) ? value : null;
}

/**
 * Copies only the editable front matter keys from a request body. Reserved keys
 * are rejected earlier; unknown keys are ignored so an update can never invent
 * front matter.
 */
export function pickEditableFrontMatter(frontMatter: unknown): EditablePostMetadata {
  const edits: EditablePostMetadata = {};
  if (!frontMatter || typeof frontMatter !== "object") return edits;
  const source = frontMatter as Record<string, unknown>;
  for (const key of EDITABLE_FRONT_MATTER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      (edits as Record<string, unknown>)[key] = source[key];
    }
  }
  return edits;
}

export type PostUpdateValidation =
  | { ok: true; edits: EditablePostMetadata }
  | { ok: false; reason: string; message: string; reservedKeys?: readonly string[] };

/**
 * The pure validation behind the `updatePost` IPC handler: given the existing
 * post's identity/status and a request body, decide whether the edit is allowed
 * and what editable front matter it carries. Pure — the filesystem checks the
 * handler still owns (the post lookup, and the `sourceId` existence probe) are
 * intentionally left out; only the self-source rule, which needs no I/O, is here.
 */
export function validatePostUpdate(
  existing: { id: string; status: PostStatus },
  updates: { frontMatter?: unknown },
): PostUpdateValidation {
  const frontMatter: unknown = updates?.frontMatter;

  // Published and expired posts are locked — editing happens only after moving
  // back to Draft or Ready.
  if (isEditLocked(existing.status)) {
    return {
      ok: false,
      reason: `${existing.status}-locked`,
      message: `${existing.status === "published" ? "Published" : "Expired"} posts are locked. Move the post back to Ready or Draft to edit it.`,
    };
  }

  if (frontMatter !== undefined && (!frontMatter || typeof frontMatter !== "object" || Array.isArray(frontMatter))) {
    return { ok: false, reason: "front-matter-not-object", message: "frontMatter must be an object" };
  }

  const reservedKeys = Object.keys((frontMatter as Record<string, unknown>) ?? {}).filter((key) =>
    RESERVED_FRONT_MATTER_KEYS.has(key),
  );
  if (reservedKeys.length > 0) {
    return {
      ok: false,
      reason: "reserved-front-matter",
      message: `Reserved front matter fields cannot be updated here: ${reservedKeys.join(", ")}`,
      reservedKeys,
    };
  }

  if (frontMatter && Object.prototype.hasOwnProperty.call(frontMatter, "slug")) {
    const slug = (frontMatter as Record<string, unknown>).slug;
    if (slug !== null && slug !== undefined && slug !== "") {
      if (!validateSlug(slug)) {
        return {
          ok: false,
          reason: "invalid-slug",
          message: "Invalid slug: only letters, digits, hyphens, and underscores are allowed",
        };
      }
    }
  }

  const edits = pickEditableFrontMatter(frontMatter);

  if (typeof edits.sourceId === "string" && edits.sourceId && edits.sourceId === existing.id) {
    return { ok: false, reason: "self-source", message: "A post cannot be its own source" };
  }

  return { ok: true, edits };
}
