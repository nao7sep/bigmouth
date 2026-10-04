/**
 * The anthropic.messages request builder: one branch per row of SUPPORTED_MODELS,
 * and the plain request for any other id (ai-model-routing-conventions). Pure, so
 * the guard test can drive every branch.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { rowFor } from "@shared/aiModels";

/** The output ceiling every request carries; the wire format requires one. */
export const MAX_TOKENS = 16_384;

/** What the feature itself asks for: the messages, and a JSON format it reads. */
export interface ClaudeFeatureRequest {
  model: string;
  system: string;
  userContent: string;
  format?: Anthropic.JSONOutputFormat;
}

type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;
type ThinkingParams = { thinking: unknown; effort?: Effort };

// `summarized` lets a caller show the reasoning while it happens; the default
// omits the text, which reads as a dead pause before any output.
const ADAPTIVE = { type: "adaptive", display: "summarized" } as const;
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"] satisfies readonly Effort[];

/** `adaptive`, or adaptive thinking at an effort level. */
function adaptiveAt(value: string): ThinkingParams {
  if (value === "adaptive") return { thinking: ADAPTIVE };
  if (EFFORTS.includes(value)) return { thinking: ADAPTIVE, effort: value as Effort };
  throw new Error(`No thinking translation for ${value}`);
}

/** The branch for a supported id; undefined for any other id. */
function branchFor(model: string, thinking: string): ThinkingParams | undefined {
  switch (rowFor(model)?.id) {
    // Adaptive only: disabling thinking is refused with a 400.
    case "claude-fable-5-1":
      return adaptiveAt(thinking);
    // Adaptive only: disabling thinking is refused with a 400 at every effort.
    case "claude-opus-5-5":
      return adaptiveAt(thinking);
    // `between_tools` is its lowest setting, valid at effort `high` or below, and
    // takes no other thinking field. The SDK's types do not list it yet.
    case "claude-sonnet-5-5":
      return thinking === "between_tools" ? { thinking: { type: "between_tools" } } : adaptiveAt(thinking);
    // Thinks only with a token budget the app would have to invent, so it lists only `off`.
    case "claude-haiku-4-5":
      if (thinking !== "off") throw new Error(`No thinking translation for ${thinking}`);
      return { thinking: { type: "disabled" } };
    default:
      return undefined;
  }
}

/**
 * The request for one call. `thinking` is the role's value for a supported id
 * (aiModels' thinkingFor); an id with no row gets the plain request — model,
 * messages, `max_tokens`, and the system prompt and format the feature asks
 * for — with no thinking parameter. No `temperature`: the current models refuse
 * a non-default one.
 */
export function buildClaudeParams(
  request: ClaudeFeatureRequest,
  thinking: string | undefined,
): Anthropic.MessageCreateParamsNonStreaming {
  const branch = thinking === undefined ? undefined : branchFor(request.model, thinking);
  const outputConfig = {
    ...(request.format ? { format: request.format } : {}),
    ...(branch?.effort ? { effort: branch.effort } : {}),
  };
  return {
    // A supported id is sent as its row spells it; any other as typed.
    model: rowFor(request.model)?.id ?? request.model.trim(),
    max_tokens: MAX_TOKENS,
    ...(branch ? { thinking: branch.thinking as Anthropic.ThinkingConfigParam } : {}),
    messages: [{ role: "user", content: request.userContent }],
    ...(request.system ? { system: request.system } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };
}
