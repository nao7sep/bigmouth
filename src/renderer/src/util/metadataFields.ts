import type { PostFrontMatter } from "@shared/types";

import { singleLine } from "./textCleanup";

// The pure marshalling between a post's front matter and the textarea string
// fields the MetadataTab edits. Kept out of the component so the tag-splitting
// and single-line/array rules are testable without rendering.

/**
 * Front matter -> the flat string fields shown in the editor. Array values
 * (tags) join with ", "; missing values become "". The English-companion fields
 * appear only for non-English posts.
 */
export function extractFields(fm: PostFrontMatter): Record<string, string> {
  const get = (key: string): string => {
    const val = (fm as Record<string, unknown>)[key];
    if (Array.isArray(val)) return val.join(", ");
    return (val as string) ?? "";
  };

  const fields: Record<string, string> = {
    title: get("title"),
    slug: get("slug"),
    tags: get("tags"),
    metaDescription: get("metaDescription"),
    extra: get("extra"),
  };

  if (fm.language !== "en") {
    fields.titleEn = get("titleEn");
    fields.tagsEn = get("tagsEn");
    fields.metaDescriptionEn = get("metaDescriptionEn");
  }

  return fields;
}

// Scalar metadata fields that are stored as a single line. They are edited in
// `<textarea>`s (which, unlike `<input>`, keep pasted newlines), so they get
// single-line cleanup at commit time — never on a keystroke. `slug` is excluded
// (validated in the main process, not normalized) and `extra` is excluded (free-text KVP).
export const SINGLE_LINE_FIELDS = new Set(["title", "titleEn", "metaDescription", "metaDescriptionEn"]);

/**
 * A raw textarea value -> the form persisted in front matter, applying commit-time
 * cleanup (so it runs on save, not while the user types). Tags split on a comma
 * or an ideographic comma (、, U+3001), trim, and drop empties into an array;
 * single-line fields collapse to one line; everything else passes through.
 */
export function parseFieldValue(key: string, value: string): string | string[] {
  if (key === "tags" || key === "tagsEn") {
    return value
      .split(/[,、]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (SINGLE_LINE_FIELDS.has(key)) return singleLine(value);
  return value;
}
