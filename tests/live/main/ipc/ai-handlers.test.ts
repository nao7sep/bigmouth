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

const ANALYSIS_TIMEOUT_MS = 4 * 60_000;
const FIELDS: MetadataField[] = ["title", "slug", "tags", "metaDescription"];

let home: string;
let wsId: string;
let postId: string;

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No IPC handler for ${channel}`);
  return handler({}, ...args) as Promise<T>;
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
