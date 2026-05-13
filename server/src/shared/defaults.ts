/**
 * Default values used when initializing the app for the first time.
 */

import type { Settings, AnalysisPrompt, AiConfigsData, GenerationPromptsData } from "./types.js";
import { nanoid } from "nanoid";
import { DEFAULT_GENERATION_PROMPTS } from "../ai/generationPrompts.js";

export const DEFAULT_PORT = 3141;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_ALLOWED_ORIGINS: string[] = [];

const defaultAiConfigId = nanoid();

export const DEFAULT_AI_CONFIGS: AiConfigsData = {
  activeId: defaultAiConfigId,
  configs: [
    {
      id: defaultAiConfigId,
      name: "Default",
      provider: "claude",
      model: "claude-sonnet-4-6",
      apiKey: "",
    },
  ],
};

export const DEFAULT_GENERATION_PROMPTS_DATA: GenerationPromptsData = {
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
    name: "Publishing Risk Review",
    text: `Review the following post for publishing readiness.

- Write the whole response in the same language as the post.
- Be constructive and calm.
- Focus only on issues that materially affect safety, trust, or publishability.
- Ignore minor issues that most readers would not care about.
- If the post is already workable, say so clearly.

Check only for:
- secrets or internal information
- private personal information
- offensive or needlessly inflammatory wording
- overclaiming that could damage trust
- obvious placeholder or unfinished text
- major clarity problems that would genuinely hurt publication

Respond with:
## What already works
- Briefly note what feels publishable already

## Important issues
- Only the few issues worth fixing before publishing

## Suggested fixes
- Concrete rewrites or actions

---

{content}`,
  },
  {
    name: "Distinctiveness & Credibility Review",
    text: `Review the following post for distinctiveness and credibility.

- Write the whole response in the same language as the post.
- Be encouraging.
- Start from what is already strong.
- Focus on the few biggest opportunities, not a long list of complaints.

Look at:
- first-hand experience, concrete observation, or real expertise
- places that feel generic or could use more specificity
- the strongest original insight and whether it stands out enough

Respond with:
## What stands out
- The strongest distinctive elements already here

## Biggest opportunities
- Only the most useful places to make the post more believable or memorable

## Suggested upgrades
- Specific additions or rewrites that would help most

---

{content}`,
  },
  {
    name: "Calibration & Bias Review",
    text: `Review the following post for calibration.

- Write the whole response in the same language as the post.
- Be fair and measured.
- Only point out passages that clearly feel overstated, emotionally skewed, or under-qualified.
- Do not treat ordinary personality or strong voice as a problem by itself.

Look for:
- claims that sound too absolute or too certain
- places where observation and interpretation are mixed together
- missing caveats that would clearly improve trust

Respond with:
## What feels well judged
- Parts that already feel measured or honest

## Passages to recalibrate
- Only the passages that would clearly benefit from softer or more precise wording

## Suggested rewrites
- More balanced alternatives

---

{content}`,
  },
  {
    name: "Reader Value & Structure Review",
    text: `Review the following post for reader value and structure.

- Write the whole response in the same language as the post.
- Be constructive.
- Focus on the few changes that would help readers most.
- Ignore minor imperfections if the post already reads well enough.

Check:
- whether the opening earns attention
- whether the post has a clear through-line
- whether any section drags or repeats too much
- whether the ending leaves a clear takeaway

Respond with:
## What already works
- Structural choices that already help the reader

## Best improvements
- The most useful fixes for hook, flow, pacing, or ending

## Suggested edits
- Concrete restructuring ideas

---

{content}`,
  },
  {
    name: "Elaboration Coach",
    text: `Act as a thoughtful editor helping the writer deepen the post.

- Write the whole response in the same language as the post.
- Be energizing, not discouraging.
- Do not focus on grammar or formality.
- Suggest only additions that seem genuinely worth the effort.
- Treat every suggestion as optional, not mandatory.

Look for chances to:
- add a missing example, scene, comparison, or evidence
- explore a better angle or a question the draft opens up
- extend the post in a way that makes it richer or more memorable

Respond with:
## Strong parts to build on
- What already gives this post life

## Questions worth exploring
- The most valuable questions to think about next

## Optional additions
- A few concrete additions that could make the post stronger

---

{content}`,
  },
];
