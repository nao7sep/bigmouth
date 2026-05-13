export const IMAGE_PROMPT_RELATIONS = ["direct", "domain", "abstract"] as const;
export const IMAGE_PROMPT_EMOTIONAL_LENSES = [
  "bright",
  "calm",
  "neutral",
  "intense",
  "hopeful",
] as const;
export const IMAGE_PROMPT_LITERALNESS = ["literal", "stylized", "symbolic"] as const;
export const IMAGE_PROMPT_PEOPLE = ["people", "mixed", "no-people"] as const;
export const IMAGE_PROMPT_STYLES = [
  "photo",
  "illustration",
  "anime",
  "cinematic",
  "minimal",
] as const;
export const IMAGE_PROMPT_COUNTS = [3, 5, 10] as const;

export type ImagePromptRelation = (typeof IMAGE_PROMPT_RELATIONS)[number];
export type ImagePromptEmotionalLens = (typeof IMAGE_PROMPT_EMOTIONAL_LENSES)[number];
export type ImagePromptLiteralness = (typeof IMAGE_PROMPT_LITERALNESS)[number];
export type ImagePromptPeople = (typeof IMAGE_PROMPT_PEOPLE)[number];
export type ImagePromptStyle = (typeof IMAGE_PROMPT_STYLES)[number];

export type ImagePromptOptions = {
  count: number;
  relation: ImagePromptRelation;
  emotionalLens: ImagePromptEmotionalLens;
  literalness: ImagePromptLiteralness;
  people: ImagePromptPeople;
  style: ImagePromptStyle;
};

export type ImagePromptContext = {
  targetName?: string;
};

export function buildImagePromptSystemPrompt(count: number): string {
  return [
    "Generate English image-generation prompts for a post.",
    `- Return exactly ${count} prompts.`,
    "- Return JSON only.",
    "- Do not wrap the JSON in markdown fences.",
    "- Do not add any text before or after the JSON.",
    '- Use this exact shape: {"items":["prompt 1","prompt 2"]}',
    "- Each item must be one complete English image-generation prompt.",
    "- Use English only as the prompt language, not as a cue for the depicted setting.",
    "- Reflect the post's overall tone and direction, not just its most alarming detail.",
    "- Avoid turning a constructive or hopeful post into a dark or tragic image unless the request clearly calls for it.",
    "- Preserve the locale, culture, environment, and social context implied by the post and metadata.",
    "- Do not replace an implied local setting with a generic foreign setting just because the prompt is written in English.",
    "- Keep institutions, architecture, clothing, signage, and everyday details aligned with the cues already present in the source material.",
    "- Do not generate titles, labels, or negative prompts.",
  ].join("\n");
}

export function buildImagePromptUserContent(
  content: string,
  options: ImagePromptOptions,
  context: ImagePromptContext
): string {
  return [
    "<parameters>",
    `  <count>${options.count}</count>`,
    `  <relation>${options.relation}</relation>`,
    `  <emotional-lens>${options.emotionalLens}</emotional-lens>`,
    `  <literalness>${options.literalness}</literalness>`,
    `  <people>${options.people}</people>`,
    `  <style>${options.style}</style>`,
    "</parameters>",
    "",
    "<source-context>",
    ...(context.targetName ? [`  <target-name>${context.targetName}</target-name>`] : []),
    "</source-context>",
    "",
    "<guidance>",
    "  <relation-direct>Stay close to the concrete subject matter of the post.</relation-direct>",
    "  <relation-domain>Stay related to the broader domain or context of the post.</relation-domain>",
    "  <relation-abstract>Focus on the underlying theme or takeaway rather than concrete details.</relation-abstract>",
    "  <people-people>Center people in the scene.</people-people>",
    "  <people-mixed>People may appear, but they do not need to dominate the image.</people-mixed>",
    "  <people-no-people>Avoid people and focus on objects, environment, or symbolic motifs.</people-no-people>",
    "  <locale>Use cues from the draft and source metadata to infer place, architecture, institutions, clothing, signage, and people. Preserve those cues unless the post clearly points elsewhere.</locale>",
    "  <english-output>English is only the language of the prompt text. Keep the visual world grounded in the source material's own context.</english-output>",
    "</guidance>",
    "",
    "<content>",
    content,
    "</content>",
  ].join("\n");
}
