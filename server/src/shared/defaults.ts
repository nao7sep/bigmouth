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
    name: "Publishability & Trust",
    text: `Review the draft for publishability, safety, accuracy, and reader trust.

- Write the whole response in the same language as the draft.
- Act as a precise editor who wants the writer to finish and publish.
- Start with concrete strengths that are actually present in the draft.
- Do not flatter. Name structural strengths, useful observations, or effective choices.
- Ignore micro-optimizations unless they materially affect trust or clarity.
- Focus on the few issues that would make the post unsafe, misleading, confusing, or unfinished.

Check for:
- private information, secrets, or unnecessary identifying detail
- factual overreach, unsupported certainty, or claims that need qualification
- wording that is needlessly inflammatory, unfair, or likely to damage credibility
- obvious placeholders, broken structure, missing context, or unfinished sections
- the strongest reason the draft is worth publishing

Respond with:
## What is already publishable
- Specific strengths that should be kept

## Must fix before publishing
- Only high-impact issues, or say "None" if there are none

## Fast fixes
- Concrete edits or decisions that would make the draft ready sooner

## Publishability call
- Ready / Nearly ready / Needs revision, with one sentence explaining why

<content>
{content}
</content>`,
  },
  {
    name: "Structure & Reader Momentum",
    text: `Review the draft for reader value, structure, and momentum.

- Write the whole response in the same language as the draft.
- Treat the draft as work in progress, not as a school assignment.
- Help the writer see what is carrying the piece forward.
- Focus on high-leverage structure: opening, promise, through-line, pacing, transitions, and ending.
- Do not make a long checklist. Prefer the smallest structural move that improves the piece most.

Look for:
- whether the opening gives readers a reason to continue
- what question, tension, claim, or story thread organizes the piece
- where the draft repeats, drifts, jumps, or loses energy
- whether the ending leaves a clear takeaway or emotional landing
- what the reader will remember after closing the page

Respond with:
## Momentum already present
- Where the draft is already easy to follow or compelling

## Where momentum drops
- The few places readers may slow down, get lost, or stop caring

## Best structural move
- The single highest-impact reordering, cut, bridge, or expansion

## Ending or next-step suggestion
- A concrete way to land the piece or move it closer to completion

<content>
{content}
</content>`,
  },
  {
    name: "Depth & Credibility",
    text: `Review the draft for specificity, depth, credibility, and distinctiveness.

- Write the whole response in the same language as the draft.
- Help the writer make the post more believable and memorable without bloating it.
- Prefer concrete additions over abstract advice.
- Preserve the writer's voice, stance, and level of emotion unless they undermine trust.
- Do not ask for citations or caveats unless they would genuinely improve credibility.

Look for:
- first-hand observation, lived detail, examples, scenes, comparisons, or useful evidence
- places that sound generic even though the writer likely knows something more specific
- claims that need a softer wording, narrower scope, or clearer distinction between fact and interpretation
- the strongest original angle and whether it is visible enough
- one or two details that would make the piece feel more earned

Respond with:
## Strongest original material
- The details, observations, or angles that give the draft life

## Add specificity here
- The best places to add an example, scene, evidence, or concrete detail

## Calibration notes
- Only claims or passages that would clearly benefit from more precise wording

## Suggested additions
- A few concrete additions or rewrites that would deepen the post efficiently

<content>
{content}
</content>`,
  },
  {
    name: "Completion Coach",
    text: `Help the writer finish the draft sooner and with more confidence.

- Write the whole response in the same language as the draft.
- Be candid, warm, and practical, but never generically nice.
- Encourage momentum by identifying what is already working and what the next useful writing action is.
- Avoid grammar policing, line edits, and perfectionism.
- Do not redesign the whole piece unless the draft truly needs it.
- Treat suggestions as options for progress, not obligations.

Look for:
- the part of the draft with the most energy or promise
- the smallest next section, paragraph, example, or transition the writer should write
- questions that would unlock useful material without sending the writer into research mode
- what can be left imperfect or ignored for now
- a reasonable stopping point for this editing pass

Respond with:
## Keep going from here
- The strongest live thread in the draft and why it is worth continuing

## Write next
- The next paragraph, section, example, or transition to draft

## Useful questions
- A few questions that would produce better material quickly

## Stop rule
- What is good enough for this pass, so the writer does not overwork the piece

<content>
{content}
</content>`,
  },
];
