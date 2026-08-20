import { useMemo } from "react";
import type { ContentFont } from "@shared/types";
import { assetUrl } from "../api";
import { renderSafeMarkdown } from "../util/safeMarkdown";

interface PreviewTabProps {
  workspaceId: string;
  content: string;
  postId: string;
  contentFont: ContentFont;
}

// A markdown image is `![alt](dest)` or `![alt](dest "title")`. Only the bare
// destination is captured; a title, if present, is carried through untouched.
const IMAGE = /!\[([^\]]*)\]\(\s*([^\s)]+)((?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?)\s*\)/g;

// Anything already addressable on its own: an absolute URL of any scheme, a
// protocol-relative URL, a root-relative path, or an in-document anchor.
const ALREADY_ADDRESSABLE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

/**
 * Rewrites bare image filenames to the asset-protocol URL that serves this
 * post's uploads, and leaves every other destination alone.
 *
 * The previous pattern excluded only a leading `/` and ran to the closing
 * paren, so it swallowed the whole rest of the reference: an `https://` image
 * became `bigmouth-asset://asset/ws/post/https%3A%2F%2F…`, a `data:` URI the
 * same, and a titled image had its title encoded into the filename. Every one
 * of those rendered as a broken image — in the tab whose entire job is showing
 * the user what the post will look like.
 */
function resolveAssetImages(markdown: string, postId: string, workspaceId: string): string {
  return markdown.replace(IMAGE, (whole, alt: string, dest: string, title: string) => {
    if (ALREADY_ADDRESSABLE.test(dest)) return whole;
    return `![${alt}](${assetUrl(postId, dest, workspaceId)}${title})`;
  });
}

export function PreviewTab({ workspaceId, content, postId, contentFont }: PreviewTabProps) {
  const html = useMemo(() => {
    if (!content.trim()) return null;
    return renderSafeMarkdown(resolveAssetImages(content, postId, workspaceId));
  }, [content, postId, workspaceId]);

  if (!html) {
    return <div className="preview-empty">No content yet</div>;
  }

  // The preview renders the user's own document, so it is content, not chrome:
  // it shares the editor's font FAMILY and sets its own size, line height and
  // padding (app-chrome-conventions, "where reading and writing are separate
  // surfaces, split the size but share the family"). A blank family inherits the
  // UI font, exactly as the editor treats it. Reading it used to be stuck at the
  // UI sans-serif at 14px however the editor was configured, so an accessibility
  // setting covered only half the artifact.
  const style = {
    ...(contentFont.family ? { fontFamily: contentFont.family } : {}),
    fontSize: contentFont.size,
    lineHeight: contentFont.lineHeight,
    padding: contentFont.padding,
    ...(contentFont.bold ? { fontWeight: 600 } : {}),
    ...(contentFont.italic ? { fontStyle: "italic" as const } : {}),
    ...(contentFont.underline ? { textDecoration: "underline" } : {}),
  };

  return (
    <div className="preview-content" style={style} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
