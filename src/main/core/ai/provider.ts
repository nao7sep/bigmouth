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
 * The model, its thinking mode, and its output budget come from the AI config and are
 * fixed for the provider's lifetime, so they are not per-call arguments.
 */

export interface AiProvider {
  generateText(systemPrompt: string, userContent: string): Promise<string>;
  generateJson(
    systemPrompt: string,
    userContent: string,
    schema: Record<string, unknown>,
    options?: {
      timeoutMs?: number;
      maxRetries?: number;
      signal?: AbortSignal;
    }
  ): Promise<unknown>;
  /**
   * `onThinking` receives the model's reasoning summary as it is produced, which only
   * happens when the config has thinking on. It is optional: a caller that has nothing
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
