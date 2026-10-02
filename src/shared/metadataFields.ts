/**
 * The generatable metadata fields, in the order the UI shows them.
 *
 * One list for both processes: it decides which keys `config.json` persists,
 * which fields the generator accepts and which rows Settings renders, so a key
 * added here reaches all three.
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
 * themselves rather than of any one consumer. The generator states the rule in
 * its own system prompt and holds the response to it, both from this set, so it
 * does not depend on the per-field prompts a user can edit.
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
 * Every site, the generator's JSON schema and its check of the response
 * included, reads these, so the schema and the check cannot disagree.
 */
export const GENERATED_SLUG_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
export const GENERATED_SLUG_MAX_LENGTH = 60;
export const GENERATED_SLUG = new RegExp(GENERATED_SLUG_PATTERN);

/** What an author may type. Deliberately looser than what the model is asked for. */
export const ACCEPTED_SLUG_MAX_LENGTH = 200;
export const ACCEPTED_SLUG = /^(?=.*[a-zA-Z0-9])[a-zA-Z0-9_-]+$/;
