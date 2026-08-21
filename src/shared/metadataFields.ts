/**
 * The generatable metadata fields, in the order the UI shows them.
 *
 * One list. It was declared byte-identically in the main process and the
 * renderer: the main copy decided which keys `config.json` persists and which
 * fields the generator accepts, the renderer copy decided which rows Settings
 * renders. Adding a key to one meant either the UI editing a prompt the store
 * dropped on save, or the store carrying a prompt no UI showed — and the
 * renderer's own header claimed it carried no copy.
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

export type MetadataField = (typeof GENERATION_PROMPT_KEYS)[number];

export function isMetadataField(value: unknown): value is MetadataField {
  return typeof value === "string" && (GENERATION_PROMPT_KEYS as readonly string[]).includes(value);
}
