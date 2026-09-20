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

/**
 * The fields whose value is English whatever language the draft is written in.
 * The rest are always in the draft's language.
 *
 * Declared here, beside the field list, because it is a property of the fields
 * themselves rather than of any one consumer. It had previously been stated
 * only inside the per-field generation prompts ("Write the English title…"),
 * which a user can edit — so the one place the app said a field must be English
 * was also the one place a user could delete it. The generator now states the
 * rule at the top of its own system prompt and holds the response to it, and
 * both read the set from here.
 */
export const ENGLISH_METADATA_FIELDS: ReadonlySet<MetadataField> = new Set<MetadataField>([
  "titleEn",
  "slug",
  "tagsEn",
  "metaDescriptionEn",
]);

/**
 * The slug rule, in the two forms the app needs.
 *
 * `GENERATED_SLUG` is what the model is asked for and held to: strict kebab
 * case, lowercase, no leading/trailing or doubled hyphens. `ACCEPTED_SLUG` is
 * what a person may type, which is looser — uppercase and underscores are
 * allowed, because rejecting a slug someone deliberately wrote is not this
 * field's job.
 *
 * Both were spelled out at four sites with two different regexes, including the
 * generator's JSON schema and a post-hoc check inside the same file — so
 * relaxing the schema still threw on a slug the schema now permitted.
 */
export const GENERATED_SLUG_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
export const GENERATED_SLUG_MAX_LENGTH = 60;
export const GENERATED_SLUG = new RegExp(GENERATED_SLUG_PATTERN);

/** What an author may type. Deliberately looser than what the model is asked for. */
export const ACCEPTED_SLUG_MAX_LENGTH = 200;
export const ACCEPTED_SLUG = /^(?=.*[a-zA-Z0-9])[a-zA-Z0-9_-]+$/;
