/**
 * Default values used when initializing the app for the first time.
 */

import type { Settings, AnalysisPrompt, AiConfigsData, GenerationPromptsData } from "./types.js";
import { nanoid } from "nanoid";
import { DEFAULT_GENERATION_PROMPTS, DEFAULT_GENERATION_PREAMBLE } from "../ai/generationPrompts.js";

export const DEFAULT_PORT = 3141;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_ALLOWED_ORIGINS: string[] = [];

const defaultAiConfigId = nanoid();

export const DEFAULT_AI_CONFIGS: AiConfigsData = {
  configs: [
    {
      id: defaultAiConfigId,
      name: "Default",
      provider: "claude",
      apiKey: "",
      model: "claude-sonnet-4-6",
    },
  ],
  activeId: defaultAiConfigId,
};

export const DEFAULT_GENERATION_PROMPTS_DATA: GenerationPromptsData = {
  preamble: DEFAULT_GENERATION_PREAMBLE,
  prompts: { ...DEFAULT_GENERATION_PROMPTS },
};

export const DEFAULT_SETTINGS: Settings = {
  timezone: "Asia/Tokyo",
  supportedLanguages: ["ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "nl", "pl", "pt", "ru", "tr", "vi", "zh"],
  publishedPostsPerLoad: 50,
  maxUploadMb: 500,
  editorWatermark:
    "Consider starting with an outline:\n- Who is this for?\n- What should they take away?\n- What are the key points?",
  extraFieldWatermark:
    "Key-value pairs, one per line:\nsubtitle: Your subtitle here\ncanonical-url: https://...",
};

export const DEFAULT_ANALYSIS_PROMPTS: AnalysisPrompt[] = [
  {
    name: "Safety & Quality Review",
    text: `Review the following post for publishing readiness. Check for:

- Security risks: API keys, tokens, internal URLs, passwords, or other secrets
- Privacy violations: personal information, email addresses, phone numbers, physical addresses, or details that could identify private individuals
- Offensive content: language that could be read as insulting, discriminatory, or needlessly provocative
- Overclaiming: statements presented as facts without evidence, or claims that are stronger than what the content supports
- Tone issues: sections that feel inconsistent, overly casual for the topic, or unintentionally aggressive
- Placeholder or incomplete content: TODO/FIXME markers, example.com URLs, lorem ipsum, incomplete sentences, or anything that looks unfinished
- Significant grammatical errors in the languages used in the post (minor issues are acceptable — the goal is not perfect writing)

For each finding, explain:
1. What the concern is
2. Why it matters
3. A suggested fix or rewrite

If no significant issues are found, say so clearly.

---

{content}`,
  },
];
