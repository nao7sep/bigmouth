import { useMemo } from "react";
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: false });

interface PreviewTabProps {
  content: string;
  postId: string;
}

export function PreviewTab({ content, postId }: PreviewTabProps) {
  const html = useMemo(() => {
    if (!content.trim()) return null;
    // Resolve image filenames to the asset serve endpoint
    const resolved = content.replace(
      /!\[([^\]]*)\]\(([^/)][^)]*)\)/g,
      (_, alt, filename) => `![${alt}](/assets/${postId}/${filename})`
    );
    return marked.parse(resolved) as string;
  }, [content, postId]);

  if (!html) {
    return <div className="preview-empty">No content yet.</div>;
  }

  return (
    <div
      className="preview-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
