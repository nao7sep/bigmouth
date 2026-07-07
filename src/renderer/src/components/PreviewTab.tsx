import { useMemo } from "react";
import { assetUrl } from "../api";
import { renderSafeMarkdown } from "../util/safeMarkdown";

interface PreviewTabProps {
  workspaceId: string;
  content: string;
  postId: string;
}

export function PreviewTab({ workspaceId, content, postId }: PreviewTabProps) {
  const html = useMemo(() => {
    if (!content.trim()) return null;
    // Resolve image filenames to the custom asset-protocol URL.
    const resolved = content.replace(
      /!\[([^\]]*)\]\(([^/)][^)]*)\)/g,
      (_, alt, filename) => `![${alt}](${assetUrl(postId, filename, workspaceId)})`
    );
    return renderSafeMarkdown(resolved);
  }, [content, postId, workspaceId]);

  if (!html) {
    return <div className="preview-empty">No content yet</div>;
  }

  return (
    <div
      className="preview-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
