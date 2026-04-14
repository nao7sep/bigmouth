import { useMemo, useState } from "react";
import { Marked } from "marked";
import removeMd from "remove-markdown";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { useEscapeKey } from "../hooks/useEscapeKey";

const marked = new Marked({ gfm: true, breaks: false });

interface ExportModalProps {
  content: string;
  slug: string;
  onClose: () => void;
}

type ExportFormat = "html" | "text";

export function ExportModal({ content, slug, onClose }: ExportModalProps) {
  useEscapeKey(onClose);
  const [format, setFormat] = useState<ExportFormat>("html");
  const { copiedKey, copy } = useCopyFeedback();

  const html = useMemo(() => marked.parse(content) as string, [content]);

  const plainText = useMemo(() => removeMd(content), [content]);

  const output = format === "html" ? html : plainText;
  const filename = slug || "export";

  const handleCopy = () => copy(output, "copy");

  const handleDownload = () => {
    const ext = format === "html" ? "html" : "txt";
    const mimeType = format === "html" ? "text/html" : "text/plain";
    const blob = new Blob([output], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Export</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="export-format-tabs">
          <button
            className={`export-format-tab${format === "html" ? " active" : ""}`}
            onClick={() => setFormat("html")}
          >
            HTML
          </button>
          <button
            className={`export-format-tab${format === "text" ? " active" : ""}`}
            onClick={() => setFormat("text")}
          >
            Plain Text
          </button>
        </div>

        <pre className="export-preview">
          {output || (
            <span style={{ color: "#aaa", fontStyle: "italic" }}>
              No content yet
            </span>
          )}
        </pre>

        <div className="export-actions">
          <button className="btn-export" onClick={handleCopy} autoFocus>
            {copiedKey === "copy" ? "✓ Copied" : "Copy"}
          </button>
          <button className="btn-export" onClick={handleDownload}>
            Download .{format === "html" ? "html" : "txt"}
          </button>
        </div>
      </div>
    </div>
  );
}
