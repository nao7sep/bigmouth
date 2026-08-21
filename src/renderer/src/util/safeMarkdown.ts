import DOMPurify from "dompurify";
import { Marked } from "marked";

const SAFE_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|bigmouth-asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

interface RenderSafeMarkdownOptions {
  resolveImageUrl?: (href: string) => string;
}

export function renderSafeMarkdown(
  markdown: string,
  options: RenderSafeMarkdownOptions = {},
): string {
  const marked = new Marked({ gfm: true, breaks: false });
  if (options.resolveImageUrl) {
    marked.use({
      walkTokens(token) {
        if (token.type === "image") token.href = options.resolveImageUrl!(token.href);
      },
    });
  }
  const html = marked.parse(markdown) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: SAFE_URI,
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "button",
      "embed",
      "form",
      "iframe",
      "input",
      "object",
      "script",
      "select",
      "style",
      "textarea",
    ],
    FORBID_ATTR: ["srcdoc", "style"],
  });
}
