/**
 * Default values used when initializing the app for the first time.
 */

import type { Settings, Prompt } from "./types.js";

export const DEFAULT_PORT = 3141;

export const DEFAULT_SETTINGS: Settings = {
  port: DEFAULT_PORT,
  timezone: "Asia/Tokyo",
  publishedPostsPerLoad: 50,
  editorWatermark:
    "Consider starting with an outline:\n- Who is this for?\n- What should they take away?\n- What are the key points?",
  extraFieldWatermark:
    "Key-value pairs, one per line:\nsubtitle: Your subtitle here\ncanonical-url: https://...",
  ai: {
    provider: "claude",
    apiKey: "",
    model: "claude-sonnet-4-6",
  },
};

export const DEFAULT_PROMPTS: Prompt[] = [
  {
    name: "Safety & Quality Review",
    text: `Review the following post for publishing readiness. Check for:

- Security risks: API keys, tokens, internal URLs, passwords, or other secrets
- Privacy violations: personal information, email addresses, phone numbers, physical addresses, or details that could identify private individuals
- Offensive content: language that could be read as insulting, discriminatory, or needlessly provocative
- Overclaiming: statements presented as facts without evidence, or claims that are stronger than what the content supports
- Tone issues: sections that feel inconsistent, overly casual for the topic, or unintentionally aggressive
- Significant grammatical errors in both English and Japanese (minor issues are acceptable — the goal is not perfect writing)

For each finding, explain:
1. What the concern is
2. Why it matters
3. A suggested fix or rewrite

If no significant issues are found, say so clearly.

---

{content}`,
  },
];
