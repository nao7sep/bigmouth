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
 * Whether a committed value has nothing visible in it.
 *
 * Zero-width characters are deliberately NOT whitespace to the cleanup helpers —
 * the text-cleanup conventions say so outright, and ZWJ is structural inside
 * emoji, so stripping them there would break a family emoji. They reserve this
 * as "a separate, explicit step", which is what this is.
 *
 * Without it, a title of one ZWSP survived cleanup, read as truthy, and rendered
 * a blank row in the post list that could not be clicked away; a tag of one was
 * an invisible tag. Both arrive by an ordinary paste from a web page.
 */
function isVisuallyEmpty(value: string): boolean {
  // ZWSP, ZWNJ, ZWJ, LRM/RLM, word joiner, BOM — the invisible formatting run.
  return value.replace(/[\u200b-\u200f\u2060\ufeff]/g, "").trim() === "";
}

/**
 * A raw textarea value -> the form persisted in front matter, applying commit-time
 * cleanup (so it runs on save, not while the user types). Tags split on a comma
 * or an ideographic comma (、, U+3001), trim, and drop empties into an array;
 * single-line fields collapse to one line; everything else passes through.
 *
 * A value with nothing visible in it commits as empty — see isVisuallyEmpty. The
 * characters themselves are never stripped from a value that has other content:
 * this decides presence, it does not scrub.
 */
export function parseFieldValue(key: string, value: string): string | string[] {
  if (key === "tags" || key === "tagsEn") {
    return value
      .split(/[,、]/)
      .map((t) => t.trim())
      .filter((tag) => !isVisuallyEmpty(tag));
  }
  if (SINGLE_LINE_FIELDS.has(key)) {
    const cleaned = singleLine(value);
    return isVisuallyEmpty(cleaned) ? "" : cleaned;
  }
  return value;
}
