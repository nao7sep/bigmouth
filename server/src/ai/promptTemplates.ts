const CONTENT_PLACEHOLDER = "{content}";
const JSON_PLACEHOLDER = "{json}";

type PromptRenderOptions = {
  content: string;
  json?: string;
};

export function usesContentPlaceholder(template: string): boolean {
  return template.includes(CONTENT_PLACEHOLDER);
}

export function usesJsonPlaceholder(template: string): boolean {
  return template.includes(JSON_PLACEHOLDER);
}

export function renderPromptTemplate(
  template: string,
  { content, json }: PromptRenderOptions
): string {
  return template
    .replaceAll(CONTENT_PLACEHOLDER, content)
    .replaceAll(JSON_PLACEHOLDER, json ?? JSON_PLACEHOLDER)
    .trim();
}

export function resolvePromptRequest(
  template: string,
  options: PromptRenderOptions
): { systemPrompt: string; userContent: string } {
  if (usesContentPlaceholder(template) || usesJsonPlaceholder(template)) {
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
