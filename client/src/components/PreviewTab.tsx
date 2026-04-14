import { useMemo } from "react";
import { Marked } from "marked";
import { assetUrl } from "../api";

const marked = new Marked({ gfm: true, breaks: false });

interface PreviewTabProps {
  workspaceId: string;
  content: string;
  postId: string;
}

export function PreviewTab({ workspaceId, content, postId }: PreviewTabProps) {
  const html = useMemo(() => {
    if (!content.trim()) return null;
    // Resolve image filenames to the asset serve endpoint
    const resolved = content.replace(
      /!\[([^\]]*)\]\(([^/)][^)]*)\)/g,
      (_, alt, filename) => `![${alt}](${assetUrl(postId, filename, workspaceId)})`
    );
    return marked.parse(resolved) as string;
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
