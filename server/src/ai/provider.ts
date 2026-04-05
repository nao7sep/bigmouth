/**
 * AI provider abstraction.
 * Each implementation receives a fully-rendered prompt and returns the
 * model's text response.
 */

export interface AiProvider {
  analyze(prompt: string): Promise<string>;
}
