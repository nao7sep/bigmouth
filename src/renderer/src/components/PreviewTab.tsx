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

// Anything already addressable on its own: an absolute URL of any scheme, a
// protocol-relative URL, a root-relative path, or an in-document anchor.
const ALREADY_ADDRESSABLE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

/**
 * Resolves a parsed Markdown image destination. Letting Marked parse first
 * handles encoded spaces, parentheses and optional titles without a second,
 * incomplete Markdown grammar in a regular expression.
 */
function resolveAssetImage(href: string, postId: string, workspaceId: string): string {
  if (ALREADY_ADDRESSABLE.test(href)) return href;
  let filename = href;
  try {
    filename = decodeURIComponent(href);
  } catch {
    // A literal malformed percent sequence is still a valid filename.
  }
  return assetUrl(postId, filename, workspaceId);
}

export function PreviewTab({ workspaceId, content, postId, contentFont }: PreviewTabProps) {
  const html = useMemo(() => {
    if (!content.trim()) return null;
    return renderSafeMarkdown(content, {
      resolveImageUrl: (href) => resolveAssetImage(href, postId, workspaceId),
    });
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
