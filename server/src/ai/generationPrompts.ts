/**
 * Built-in system prompt instructions for metadata field generation.
 *
 * The preamble and field instructions are stored separately so the UI can
 * display and edit them independently. The server combines them at generation
 * time: preamble + "\n" + fieldInstruction.
 *
 * All prompts are language-agnostic: base fields instruct the model to match
 * the content's language; *En variants explicitly request English output.
 */

export const DEFAULT_GENERATION_PREAMBLE =
  `The user message is the draft of a post written by the person who will publish it.\n` +
  `- Treat the draft as the author's own words, not as something being reviewed from the outside.\n` +
  `- Generate metadata that helps the author present their own post to readers.\n` +
  `- Preserve the author's narrative perspective and relationships when natural. If the draft is written in first person, prefer first-person framing such as "my", "I", or "we" instead of outsider wording like "a father" or "the author", unless the draft clearly calls for third-person wording.\n` +
  `- Stay faithful to the draft. Do not invent roles, labels, or audience framing that the draft does not support.\n` +
  `- Output plain text only — no markdown, no headers, no asterisks, no bullet points.\n` +
  `- Start directly with the output — no preamble like "Here is..." or "Sure,..."\n` +
  `- Do not add notes, warnings, or commentary after the output.`;

export const DEFAULT_GENERATION_PROMPTS: Record<string, string> = {
  title:
    `Generate a concise, engaging title in the same language as the content.\n` +
    `- Prefer wording that sounds like the author naming their own post, not an outside reviewer summarizing it.\n` +
    `- Return only the title text.`,
  titleEn:
    `Generate a concise, engaging title in English for the content.\n` +
    `- Prefer wording that sounds like the author naming their own post, not an outside reviewer summarizing it.\n` +
    `- Return only the title text.`,
  slug:
    `Generate a URL-friendly slug in English.\n` +
    `- Use only lowercase letters, numbers, and hyphens.\n` +
    `- Maximum 60 characters.\n` +
    `- When possible, preserve the post's own framing instead of outsider labels.\n` +
    `- Return only the slug.`,
  tags:
    `Generate 5 to 8 relevant tags in the same language as the content.\n` +
    `- Keep them topical, and avoid outsider labels for the author unless the draft clearly uses them.\n` +
    `- Return only a comma-separated list of tags, nothing else.`,
  tagsEn:
    `Generate 5 to 8 relevant tags in English.\n` +
    `- Keep them topical, and avoid outsider labels for the author unless the draft clearly uses them.\n` +
    `- Return only a comma-separated list of tags, nothing else.`,
  metaDescription:
    `Write a compelling SEO meta description in the same language as the content.\n` +
    `- Length: 120–160 characters.\n` +
    `- Write it from the author's perspective rather than as an external reviewer's summary.\n` +
    `- Return only the description text.`,
  metaDescriptionEn:
    `Write a compelling SEO meta description in English.\n` +
    `- Length: 120–160 characters.\n` +
    `- Write it from the author's perspective rather than as an external reviewer's summary.\n` +
    `- Return only the description text.`,
};

/**
 * Returns the combined system prompt for a given field key.
 * Combines the preamble with the field-specific instruction.
 * Returns null if the field is not a generatable metadata key.
 */
export function systemPromptForField(
  field: string,
  preamble: string,
  customPrompts: Record<string, string>
): string | null {
  if (!(field in DEFAULT_GENERATION_PROMPTS)) return null;
  const instruction = customPrompts[field] ?? DEFAULT_GENERATION_PROMPTS[field];
  return `${preamble}\n${instruction}`;
}
