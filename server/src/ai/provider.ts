/**
 * AI provider abstraction.
 *
 * systemPrompt: instructions for the model (maps to the Claude `system` parameter)
 * userContent:  the content being acted on (maps to the user turn)
 *
 * Keeping the two arguments separate lets each provider route them correctly
 * (e.g. Claude's system parameter vs. a user message prefix).
 */

export interface AiProvider {
  generateText(systemPrompt: string, userContent: string): Promise<string>;
}
