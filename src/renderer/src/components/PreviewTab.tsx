import { useMemo } from "react";
import type { ContentFont } from "@shared/types";
import type { AssetMeta } from "@shared/types";
import { assetDerivativeUrl, assetUrl } from "../api";
import { renderSafeMarkdown } from "../util/safeMarkdown";
import { assetPicture } from "../util/assetImages";
import { usePostAssets } from "../hooks/usePostAssets";
import { useI18n } from "../i18n/I18nContext";

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
 *
 * An attached still image is shown through its display image, an animated one
 * and any other file as itself (see assetPicture). Until the post's assets have
 * been listed, an attachment gets no address, so a large original is not loaded
 * only to be replaced a moment later; a reference to a file not attached, or a
 * failed listing, keeps the original's address.
 */
function resolveAssetImage(
  href: string,
  postId: string,
  workspaceId: string,
  assets: readonly AssetMeta[] | null | undefined,
): string {
  if (ALREADY_ADDRESSABLE.test(href)) return href;
  let filename = href;
  try {
    filename = decodeURIComponent(href);
  } catch {
    // A literal malformed percent sequence is still a valid filename.
  }
  if (assets === undefined) return "";
  const asset = assets?.find((candidate) => candidate.filename === filename);
  const picture = asset ? assetPicture(asset) : null;
  if (picture?.kind === "derived") return assetDerivativeUrl("display", picture.contentHash);
  return assetUrl(postId, filename, workspaceId);
}

export function PreviewTab({ workspaceId, content, postId, contentFont }: PreviewTabProps) {
  const { t } = useI18n();
  const assets = usePostAssets(workspaceId, postId);
  const html = useMemo(() => {
    if (!content.trim()) return null;
    return renderSafeMarkdown(content, {
      resolveImageUrl: (href) => resolveAssetImage(href, postId, workspaceId, assets),
      lazyImages: true,
    });
  }, [content, postId, workspaceId, assets]);

  if (!html) {
    return <div className="preview-empty">{t("export.empty")}</div>;
  }

  // The preview shows the user's document in the content font, as the editor
  // does; a blank family inherits the UI font (app-chrome-conventions).
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
