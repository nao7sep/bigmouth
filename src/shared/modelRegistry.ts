/**
 * The models BigMouth offers, and the parameters derived from a choice.
 *
 * Split out of the general type declarations so the file's name says what it
 * holds — and so its guard test has a path that names its subject. The list is
 * app-owned and closed; nothing here reaches a provider.
 */

/**
 * A model bigmouth supports, with the capabilities that shape its request. The set
 * is app-owned and closed: the user picks a row and never edits it, so an app update
 * delivers a newer lineup on its own and there is nothing to reset — the
 * config-seeding-conventions case of "an app-owned model list whose parameters are
 * coupled to the model".
 *
 * The list is deliberately NOT a mirror of the provider's catalogue: it claims only
 * what these three models do. `maxOutput` and `supportsAdaptiveThinking` were verified
 * against the live API at design time; the app itself never queries a provider list
 * and lets a bad request fail fast.
 */
export interface ModelDef {
  id: string;
  label: string;
  /**
   * The model's own output ceiling, used only to derive a sane starting budget. The
   * app does NOT police it: a budget the model won't accept is the API's judgment,
   * surfaced at call time (config-seeding's validity boundary).
   */
  maxOutput: number;
  /**
   * Adaptive thinking is the only thinking mode current models accept. Haiku rejects
   * it outright (400 "adaptive thinking is not supported on this model"), so a request
   * for it must never be built.
   */
  supportsAdaptiveThinking: boolean;
}

/**
 * Ordered most- to least-capable, ONE PER TIER: a superseded id is removed, not kept
 * beside its successor. Opus 5 replaced Opus 4.8 at identical pricing and limits, and
 * Sonnet 4.6 left when Sonnet 5 made it redundant — a list carrying both generations
 * of a tier only asks the user to compare things that do not need comparing. A config
 * still pinned to a departed id keeps it: the picker shows it as "(not available)".
 */
export const MODEL_DEFS: readonly ModelDef[] = [
  { id: "claude-opus-5", label: "Opus 5", maxOutput: 128_000, supportsAdaptiveThinking: true },
  { id: "claude-sonnet-5", label: "Sonnet 5", maxOutput: 128_000, supportsAdaptiveThinking: true },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", maxOutput: 64_000, supportsAdaptiveThinking: false },
];

export const DEFAULT_MODEL_ID = "claude-sonnet-5";

export function findModelDef(id: string): ModelDef | undefined {
  return MODEL_DEFS.find((m) => m.id === id);
}

/** A model's starting output budget: a tenth of what it can produce. */
export function defaultMaxTokens(model: ModelDef): number {
  return Math.floor(model.maxOutput / 10);
}

/**
 * Why a budget is unusable, or null when it is fine. This checks only that the number
 * is a sane one to send — whether the model will accept it is not ours to decide, and
 * a rejected value surfaces as the API's own error at call time.
 */
export function validateMaxTokens(maxTokens: number): string | null {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    return "Max tokens must be a whole number of 1 or more.";
  }
  return null;
}

/** Adaptive thinking is only ever on for a model that accepts it. */
export function resolveThinking(model: ModelDef, requested: boolean): boolean {
  return model.supportsAdaptiveThinking && requested;
}
