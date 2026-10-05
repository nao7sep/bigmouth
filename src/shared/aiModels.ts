// Which models BigMouth supports and how it splits its AI work, per the
// ai-model-routing-conventions. Each row has its branch in the request builder
// (src/main/core/ai/claudeRequest.ts); any other id gets the plain request.

export type AiProvider = "anthropic";
export type ModelKind = "text-frontier" | "text-smart" | "text-balanced" | "text-fast";

// The lineup research document the rows and defaults below come from.
export const MODEL_LINEUP = "ai-model-lineup-20261004";

export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com";

// Product names, a display mapping at the interface edge; the id is the api-key id.
export const PROVIDER_LABELS: Record<AiProvider, string> = { anthropic: "Anthropic" };

export interface SupportedModel {
  provider: AiProvider;
  id: string;
  kinds: readonly ModelKind[];
  defaultFor: readonly ModelKind[];
  // The thinking values the model accepts, in the provider's own words, in the
  // order its field lists them.
  thinking: readonly string[];
  // The value a role takes on this model until the user changes it; it follows
  // the model's tier, not the role's (ai-model-routing-conventions, Thinking).
  defaultThinking: string;
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  { provider: "anthropic", id: "claude-fable-5-1", kinds: ["text-frontier"], defaultFor: [], thinking: ["adaptive", ...EFFORT_LEVELS], defaultThinking: "adaptive" },
  { provider: "anthropic", id: "claude-opus-5-5", kinds: ["text-smart"], defaultFor: ["text-smart"], thinking: ["adaptive", ...EFFORT_LEVELS], defaultThinking: "adaptive" },
  { provider: "anthropic", id: "claude-sonnet-5-5", kinds: ["text-balanced"], defaultFor: ["text-balanced"], thinking: ["between_tools", "adaptive", ...EFFORT_LEVELS], defaultThinking: "adaptive" },
  { provider: "anthropic", id: "claude-haiku-4-5", kinds: ["text-fast"], defaultFor: ["text-fast"], thinking: ["off"], defaultThinking: "off" },
];

export const AI_ROLES = [
  // Reads a draft and reasons about it; the balanced tier weighs it well.
  { id: "analysis", kind: "text-balanced" },
  // Titles, slugs, summaries and similar fields as structured JSON; short and formulaic.
  { id: "metadata", kind: "text-fast" },
  // Prompts written for an image generator; they need judgment.
  { id: "imagingPrompts", kind: "text-balanced" },
] as const satisfies readonly { id: string; kind: ModelKind }[];

export type AiRole = (typeof AI_ROLES)[number]["id"];
export const AI_ROLE_IDS: readonly AiRole[] = AI_ROLES.map((role) => role.id);

export function kindOf(role: AiRole): ModelKind {
  return AI_ROLES.find(({ id }) => id === role)!.kind;
}

// A model id is its own key, matched trimmed and case-insensitively.
export function rowFor(id: string): SupportedModel | undefined {
  const key = id.trim().toLowerCase();
  return SUPPORTED_MODELS.find((row) => row.id === key);
}

export function modelsFor(provider: AiProvider, kind: ModelKind): readonly SupportedModel[] {
  return SUPPORTED_MODELS.filter((row) => row.provider === provider && row.kinds.includes(kind));
}

export function defaultModelFor(provider: AiProvider, kind: ModelKind): string {
  const rows = modelsFor(provider, kind);
  const row = rows.find((model) => model.defaultFor.includes(kind)) ?? rows[0];
  if (!row) throw new Error(`No models for ${provider}/${kind}.`);
  return row.id;
}

// The value a role sends: its chosen value when the model's row lists it, else the
// row's default; a model with no row sends no thinking value.
export function thinkingFor(model: string, chosen: string): string | undefined {
  const row = rowFor(model);
  if (!row) return undefined;
  return row.thinking.includes(chosen) ? chosen : row.defaultThinking;
}

// A model field edit: the Thinking value it leaves, and the last listed id the field
// has held. The value starts at the new row's default only when the edit reaches a
// different row than that last listed one; an id with no row, passed through while
// typing or landed on, keeps both, so the choice stays stored, hidden and unsent,
// and returning to the same row keeps it. A field that opens on an unlisted id has
// held no row yet, so the first row it reaches keeps the value when it lists it and
// otherwise sets its default.
export function thinkingAfterModelEdit(
  lastListedModel: string,
  nextModel: string,
  chosen: string,
): { thinking: string; lastListedModel: string } {
  const next = rowFor(nextModel);
  if (!next) return { thinking: chosen, lastListedModel };
  const held = rowFor(lastListedModel);
  const keeps = held ? next === held : next.thinking.includes(chosen);
  return { thinking: keeps ? chosen : next.defaultThinking, lastListedModel: nextModel };
}

// A row with one thinking value offers no choice, so it shows no Thinking field.
export function hasThinkingChoice(row: SupportedModel | undefined): row is SupportedModel {
  return row !== undefined && row.thinking.length > 1;
}
