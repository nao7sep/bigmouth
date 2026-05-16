/**
 * AI provider abstraction.
 *
 * systemPrompt: instructions for the model (maps to the Claude `system` parameter)
 * userContent:  the user turn payload. This may be the raw post content or a
 *               fully rendered prompt template containing {content}.
 *
 * Keeping the two arguments separate lets each provider route them correctly
 * (e.g. Claude's system parameter vs. a user message prefix).
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
      maxTokens?: number;
      signal?: AbortSignal;
    }
  ): Promise<unknown>;
  generateTextStream(
    systemPrompt: string,
    userContent: string,
    onText: (delta: string) => void
  ): {
    abort: () => void;
    finished: Promise<string>;
  };
}
