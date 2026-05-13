/**
 * Built-in system prompt instructions for metadata field generation.
 *
 * Each field prompt is self-contained. The full draft is always sent as the
 * user message, and the selected field prompt becomes the model's system
 * prompt.
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

export const DEFAULT_GENERATION_PROMPTS: Record<string, string> = {
  title:
    `Generate a concise title in the same language as the draft.\n` +
    `- Stay close to what the draft actually says.\n` +
    `- Keep the author's perspective.\n` +
    `- Return only the title.`,
  titleEn:
    `Generate a concise English title for the draft.\n` +
    `- Stay close to what the draft actually says.\n` +
    `- Keep the author's perspective.\n` +
    `- Do not add extra drama or stronger emotion.\n` +
    `- Return only the title.`,
  slug:
    `Generate an English slug based on the main topic of the draft.\n` +
    `- Use only lowercase letters, numbers, and hyphens.\n` +
    `- Maximum 60 characters.\n` +
    `- Return only the slug.`,
  tags:
    `Generate 5 to 8 tags in the same language as the draft.\n` +
    `- Focus on the main concrete topics.\n` +
    `- Return only a comma-separated list.`,
  tagsEn:
    `Generate 5 to 8 tags in English.\n` +
    `- Focus on the main concrete topics.\n` +
    `- Return only a comma-separated list.`,
  metaDescription:
    `Write a meta description in the same language as the draft.\n` +
    `- Length: 120-160 characters.\n` +
    `- Stay close to what the draft actually says.\n` +
    `- Keep the author's perspective.\n` +
    `- Return only the description.`,
  metaDescriptionEn:
    `Write an English meta description for the draft.\n` +
    `- Length: 120-160 characters.\n` +
    `- Stay close to what the draft actually says.\n` +
    `- Keep the author's perspective.\n` +
    `- Do not add extra drama or stronger emotion.\n` +
    `- Return only the description.`,
};

/**
 * Returns the system prompt for a given field key.
 * Returns null if the field is not a generatable metadata key.
 */
export function systemPromptForField(
  field: string,
  customPrompts: Record<string, string>
): string | null {
  if (!(field in DEFAULT_GENERATION_PROMPTS)) return null;
  return customPrompts[field] ?? DEFAULT_GENERATION_PROMPTS[field];
}
