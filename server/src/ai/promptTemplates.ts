const CONTENT_PLACEHOLDER = "{content}";

type PromptRenderOptions = {
  content: string;
};

export function usesContentPlaceholder(template: string): boolean {
  return template.includes(CONTENT_PLACEHOLDER);
}

export function renderPromptTemplate(
  template: string,
  { content }: PromptRenderOptions
): string {
  return template.replaceAll(CONTENT_PLACEHOLDER, content).trim();
}

export function resolvePromptRequest(
  template: string,
  options: PromptRenderOptions
): { systemPrompt: string; userContent: string } {
  if (usesContentPlaceholder(template)) {
    return {
      systemPrompt: "",
      userContent: renderPromptTemplate(template, options),
    };
  }

  return {
    systemPrompt: template.trim(),
    userContent: options.content,
  };
}
