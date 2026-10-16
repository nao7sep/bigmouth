import DOMPurify from "dompurify";
import { Marked } from "marked";

const SAFE_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|bigmouth-asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

interface RenderSafeMarkdownOptions {
  resolveImageUrl?: (href: string) => string;
  /** Images load only as they scroll into view and decode off the main thread. */
  lazyImages?: boolean;
}

// Set after sanitizing, on the elements the sanitizer kept.
function markImageLazy(node: Element): void {
  if (node.tagName !== "IMG") return;
  node.setAttribute("loading", "lazy");
  node.setAttribute("decoding", "async");
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
  // The hook is the sanitizer's, which is shared, so it is set for this one
  // synchronous call only.
  if (options.lazyImages) DOMPurify.addHook("afterSanitizeAttributes", markImageLazy);
  try {
    return sanitize(html);
  } finally {
    if (options.lazyImages) DOMPurify.removeHook("afterSanitizeAttributes", markImageLazy);
  }
}

function sanitize(html: string): string {
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
