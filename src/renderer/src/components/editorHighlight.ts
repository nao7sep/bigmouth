import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// CodeMirror's default highlight style with every color read from a palette
// token (App.css --bm-syntax-*), so syntax colors follow the theme. As a
// non-fallback style it replaces the editor setup's fallback default style
// rather than layering on it.
export const editorHighlightStyle = HighlightStyle.define([
  { tag: tags.meta, color: "var(--bm-syntax-meta)" },
  { tag: tags.link, textDecoration: "underline" },
  { tag: tags.heading, textDecoration: "underline", fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.keyword, color: "var(--bm-syntax-keyword)" },
  { tag: [tags.atom, tags.bool, tags.url, tags.contentSeparator, tags.labelName], color: "var(--bm-syntax-atom)" },
  { tag: [tags.literal, tags.inserted], color: "var(--bm-syntax-literal)" },
  { tag: [tags.string, tags.deleted], color: "var(--bm-syntax-string)" },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: "var(--bm-syntax-regexp)" },
  { tag: tags.definition(tags.variableName), color: "var(--bm-syntax-definition)" },
  { tag: tags.local(tags.variableName), color: "var(--bm-syntax-local)" },
  { tag: [tags.typeName, tags.namespace], color: "var(--bm-syntax-type)" },
  { tag: tags.className, color: "var(--bm-syntax-class)" },
  { tag: [tags.special(tags.variableName), tags.macroName], color: "var(--bm-syntax-special)" },
  { tag: tags.definition(tags.propertyName), color: "var(--bm-syntax-property)" },
  { tag: tags.comment, color: "var(--bm-syntax-comment)" },
  { tag: tags.invalid, color: "var(--bm-syntax-invalid)" },
]);

export const editorHighlighting = syntaxHighlighting(editorHighlightStyle);
