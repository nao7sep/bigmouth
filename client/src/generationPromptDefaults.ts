/**
 * Generation prompt field order and labels used by the Settings UI.
 *
 * Prompt text defaults come from the server so the client does not carry its
 * own copy of built-in prompt content.
 */

export const GENERATION_PROMPT_KEYS = [
  "title",
  "titleEn",
  "slug",
  "tags",
  "tagsEn",
  "metaDescription",
  "metaDescriptionEn",
] as const;

export const GENERATION_PROMPT_LABELS: Record<string, string> = {
  title: "Title",
  titleEn: "Title (English)",
  slug: "Slug",
  tags: "Tags",
  tagsEn: "Tags (English)",
  metaDescription: "Description",
  metaDescriptionEn: "Description (English)",
};
