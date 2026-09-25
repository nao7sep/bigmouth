// The three AI features through their real IPC handlers and the real Anthropic
// API, with only Electron's ipcMain substituted: metadata generation, image
// prompts, and the streamed analysis, on a real workspace and post in a
// throwaway home. Run only by npm run test:full, through vitest.live.config.ts.
// The key comes from ANTHROPIC_API_KEY, which the app's own resolver reads
// before any stored key; the throwaway home stores none.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CHANNELS, type AnalysisStreamFrame, type MetadataGenerationResults } from "@shared/ipc";
import { GENERATED_SLUG, type MetadataField } from "@shared/metadataFields";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    on: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
  },
}));

import { IMAGING_LITERALNESS, IMAGING_MOODS, IMAGING_PEOPLE, IMAGING_RELATIONS, IMAGING_STYLES } from "@main/core/ai/imaging.js";
import { createPost, updatePost } from "@main/core/services/postStore.js";
import { createWorkspace, initAppDir } from "@main/core/services/workspaceStore.js";
import { DEFAULT_ANALYSIS_PROMPTS } from "@main/core/shared/defaults.js";
import { registerAnalysisHandlers } from "@main/ipc/analysis.js";
import { registerImagingHandlers } from "@main/ipc/imaging.js";
import { registerMetadataHandlers } from "@main/ipc/metadata.js";

const DRAFT = `Spring is the busiest season in a small vegetable garden. Before sowing anything,
loosen the soil to a spade's depth and work in a few centimetres of compost, which feeds the
soil life that feeds the plants. Start peas and spinach as soon as the ground can be worked,
because both tolerate cold nights. Wait for the last frost before planting tomatoes and beans.
Water deeply once or twice a week rather than a little every day, so roots grow down instead of
staying near the surface. A thin layer of mulch keeps the moisture in and the weeds down.`;

// A Japanese draft, with Japanese metadata already saved against it. Both halves
// matter: the English supplements used to come back in Japanese, and the reason
// was partly that the saved Japanese values arrived as metadata to stay
// consistent with. A draft alone would not reproduce the condition.
const JA_DRAFT = `三ヶ月前から、朝に三十分だけ歩くようにしている。

始めた理由は単純で、一日中机に向かっていると夕方には頭が働かなくなるからだった。運動不足を
解消したいというより、考える時間が欲しかった。

続けてみて意外だったのは、体調の変化よりも先に、仕事の進め方が変わったことだ。歩いている間は
メモを取れないので、頭の中だけで問題を転がすことになる。細部を詰められない代わりに、その日に
何を片付けるべきかがはっきりする。

道順は毎回同じにしている。選ぶ余地をなくすと、出かけるまでの迷いがなくなる。`;

const JA_METADATA = {
  title: "朝の散歩を三ヶ月続けて分かったこと",
  tags: ["散歩", "習慣", "健康", "早起き", "記録"],
  metaDescription:
    "毎朝三十分の散歩を三ヶ月続けた記録。体調の変化よりも、考えが整理される時間として役に立った話。",
};

const ANALYSIS_TIMEOUT_MS = 4 * 60_000;
const FIELDS: MetadataField[] = ["title", "slug", "tags", "metaDescription"];
// One request spanning both rules, so a single call shows the split holding
// rather than each side passing in isolation.
const MIXED_FIELDS: MetadataField[] = ["titleEn", "tagsEn", "metaDescriptionEn", "title"];

/**
 * Deliberately NOT the app's own `isEnglishScript`.
 *
 * The handler already rejects a field that check fails, so reusing it here would
 * assert only that the code agrees with itself — any value that arrives has
 * passed it by definition. This is an independent, stricter reading (plain ASCII
 * letters, 70%), so the test still holds the line if that threshold is ever
 * loosened, and it fails loudly if a value comes back in the draft's language.
 */
function mostlyAsciiLetters(value: string): boolean {
  const letters = [...value].filter((character) => /\p{L}/u.test(character));
  if (letters.length === 0) return false;
  return letters.filter((character) => /[A-Za-z]/.test(character)).length / letters.length >= 0.7;
}

const HAS_JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

let home: string;
let wsId: string;
let postId: string;
let jaPostId: string;

// The window a request comes from, as the AI request registry sees it.
const ownerWindow = { id: 1, once: () => {}, on: () => {} };
let nextRequestId = 1;

/** Invokes a cancellable AI handler the way the preload does: window, then request id. */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No IPC handler for ${channel}`);
  return handler({ sender: ownerWindow }, `live-${nextRequestId++}`, ...args) as Promise<T>;
}

beforeAll(() => {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. The full run calls the real Anthropic API; export ANTHROPIC_API_KEY and run it again.",
    );
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-live-"));
  process.env.BIGMOUTH_HOME = home;
  initAppDir();
  registerMetadataHandlers();
  registerImagingHandlers();
  registerAnalysisHandlers();
  const workspace = createWorkspace("Live");
  wsId = workspace.id;
  const post = createPost(workspace.dataDirectory, "blogger", "en");
  postId = post.frontMatter.id;
  updatePost(workspace.dataDirectory, postId, { content: DRAFT });

  const jaPost = createPost(workspace.dataDirectory, "blogger", "ja");
  jaPostId = jaPost.frontMatter.id;
  updatePost(workspace.dataDirectory, jaPostId, { content: JA_DRAFT, frontMatter: JA_METADATA });
});

afterAll(() => {
  delete process.env.BIGMOUTH_HOME;
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe("the live AI handlers", () => {
  it("generates the core metadata fields for an English draft", async () => {
    const results = await invoke<MetadataGenerationResults>(CHANNELS.generateMetadata, wsId, postId, FIELDS, "");
    for (const field of FIELDS) {
      const result = results[field];
      expect(result, field).toHaveProperty("value");
      expect((result as { value: string }).value.trim(), field).not.toBe("");
    }
    expect((results.slug as { value: string }).value).toMatch(GENERATED_SLUG);
  });

  // The only lane that reaches what the language fix changed. Unit tests prove
  // the request states the rule; only a real call proves the model answers in
  // English, and only a real call puts the script check in front of real output
  // — where the risk it introduced is rejecting a legitimate English value that
  // carries a Japanese name.
  it("answers a Japanese draft in English for the English fields, and in Japanese for the rest", async () => {
    const results = await invoke<MetadataGenerationResults>(
      CHANNELS.generateMetadata,
      wsId,
      jaPostId,
      MIXED_FIELDS,
      "",
    );

    for (const field of MIXED_FIELDS) {
      const result = results[field];
      // An `error` here is the failure that matters most: either the model
      // ignored the output-language rule, or the script check refused a value
      // it should have accepted. Both surface as a field that never generated.
      expect(result, `${field}: ${JSON.stringify(result)}`).toHaveProperty("value");
    }

    for (const field of ["titleEn", "tagsEn", "metaDescriptionEn"] as const) {
      const value = (results[field] as { value: string }).value;
      expect(mostlyAsciiLetters(value), `${field} was not English: ${value}`).toBe(true);
    }

    // The same request must not drag the native field into English either.
    const title = (results.title as { value: string }).value;
    expect(HAS_JAPANESE.test(title), `title was not Japanese: ${title}`).toBe(true);
  });

  it("generates the requested number of image prompts", async () => {
    const prompts = await invoke<string[]>(CHANNELS.generateImaging, wsId, postId, "", {
      count: 3,
      relation: IMAGING_RELATIONS[0],
      emotionalLens: IMAGING_MOODS[0],
      literalness: IMAGING_LITERALNESS[0],
      people: IMAGING_PEOPLE[0],
      style: IMAGING_STYLES[0],
    });
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) expect(prompt.trim()).not.toBe("");
  });

  it("streams an analysis to completion", async () => {
    const frames: AnalysisStreamFrame[] = [];
    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No final frame after ${ANALYSIS_TIMEOUT_MS} ms.`)), ANALYSIS_TIMEOUT_MS);
      const sender = {
        ...ownerWindow,
        isDestroyed: () => false,
        send: (_channel: string, frame: AnalysisStreamFrame) => {
          frames.push(frame);
          if (frame.type === "done" || frame.type === "error") {
            clearTimeout(timer);
            resolve();
          }
        },
      };
      // The streaming handler answers through event.sender, so it gets a real event.
      const start = handlers.get(CHANNELS.analysisStreamStart);
      if (!start) throw new Error(`No IPC handler for ${CHANNELS.analysisStreamStart}`);
      void start({ sender }, "live-analysis", {
        wsId,
        postId,
        promptName: DEFAULT_ANALYSIS_PROMPTS[0]!.name,
        content: "",
      });
    });
    await finished;
    const last = frames.at(-1);
    expect(last, JSON.stringify(last)).toEqual({ type: "done" });
    const text = frames.flatMap((frame) => (frame.type === "delta" ? [frame.text] : [])).join("");
    expect(text.trim()).not.toBe("");
  });
});
