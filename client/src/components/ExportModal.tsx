import { useMemo, useState } from "react";
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: false });

interface ExportModalProps {
  content: string;
  slug: string;
  onClose: () => void;
}

type ExportFormat = "html" | "text";

export function ExportModal({ content, slug, onClose }: ExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>("html");

  const html = useMemo(() => marked.parse(content) as string, [content]);

  const plainText = useMemo(() => {
    // Strip markdown syntax for a rough plain-text version
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body.textContent ?? "";
  }, [html]);

  const output = format === "html" ? html : plainText;
  const filename = slug || "export";

  const handleCopy = () => {
    navigator.clipboard.writeText(output).catch(() => {});
  };

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

        <div className="export-actions">
          <button className="btn-export" onClick={handleCopy}>
            Copy
          </button>
          <button className="btn-export" onClick={handleDownload}>
            Download .{format === "html" ? "html" : "txt"}
          </button>
        </div>

        <pre className="export-preview">{output}</pre>
      </div>
    </div>
  );
}
