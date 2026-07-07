import DOMPurify from "dompurify";
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: false });

export function renderSafeMarkdown(markdown: string): string {
  const html = marked.parse(markdown) as string;
  return DOMPurify.sanitize(html, {
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
