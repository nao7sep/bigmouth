/**
 * AI provider abstraction.
 *
 * systemPrompt: instructions for the model (maps to the Claude `system` parameter)
 * userContent:  the user turn payload. This may be the raw post content or a
 *               fully rendered prompt template containing {content}.
 *
 * Keeping the two arguments separate lets each provider route them correctly
 * (e.g. Claude's system parameter vs. a user message prefix).
 *
 * The model and its thinking value come from the role's settings and are fixed
 * for the provider's lifetime, so they are not per-call arguments.
 */

/** What a provider call belongs to, kept on its record. */
export type ProviderCallContext = {
  workspaceId: string;
  postId: string;
  purpose: "analysis" | "metadata" | "imaging";
};

export interface AiProvider {
  generateJson(
    systemPrompt: string,
    userContent: string,
    schema: Record<string, unknown>,
    options?: {
      /** A generous outer cap on the whole call; inactivity is what bounds it. */
      maxDurationMs?: number;
      /** The caller's retry policy; the client itself never retries a paid call. */
      maxRetries?: number;
      signal?: AbortSignal;
    }
  ): Promise<unknown>;
  /**
   * `onThinking` receives the model's reasoning summary as it is produced, which only
   * happens when the role's thinking is adaptive. It is optional: a caller that has nothing
   * to show it simply omits it.
   */
  generateTextStream(
    systemPrompt: string,
    userContent: string,
    onText: (delta: string) => void,
    onThinking?: (delta: string) => void
  ): {
    abort: () => void;
    finished: Promise<string>;
  };
}
