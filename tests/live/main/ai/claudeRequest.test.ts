// One real call per supported row and thinking kind, proving the provider
// accepts each branch's request (ai-model-routing-conventions). The request is
// the builder's own, with only the output ceiling lowered and the shortest
// prompt, since the lane proves the request path, not the answer. Run only by
// npm run test:full, through vitest.live.config.ts; the key comes from
// ANTHROPIC_API_KEY.

import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

import { ANTHROPIC_ENDPOINT, SUPPORTED_MODELS } from "@shared/aiModels";
import { buildClaudeParams } from "@main/core/ai/claudeRequest.js";

const MAX_TOKENS = 64;
const CALL_TIMEOUT_MS = 60_000;

// Each row at its default thinking, and Sonnet 5.5's between_tools, its one
// thinking kind besides adaptive; every effort level is adaptive thinking with
// an effort the lineup survey already tested.
const CASES: readonly [model: string, thinking: string][] = [
  ...SUPPORTED_MODELS.map((row) => [row.id, row.defaultThinking] as [string, string]),
  ["claude-sonnet-5-5", "between_tools"],
];

let client: Anthropic;

beforeAll(() => {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. The full run calls the real Anthropic API; export ANTHROPIC_API_KEY and run it again.",
    );
  }
  client = new Anthropic({ apiKey, baseURL: ANTHROPIC_ENDPOINT, maxRetries: 0, timeout: CALL_TIMEOUT_MS });
});

describe("each supported row's request", () => {
  it.each(CASES)("is accepted for %s at %s", async (model, thinking) => {
    const params = buildClaudeParams({ model, system: "", userContent: "Reply with: ok" }, thinking);
    const message = await client.messages.create({ ...params, max_tokens: MAX_TOKENS });
    expect(message.model).toContain(model);
    expect(["end_turn", "max_tokens"]).toContain(message.stop_reason);
  });
});
