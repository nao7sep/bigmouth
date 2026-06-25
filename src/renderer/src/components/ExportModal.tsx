import { useMemo, useState } from "react";
import { Marked } from "marked";
import removeMd from "remove-markdown";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { ModalShell } from "./ModalShell";

const marked = new Marked({ gfm: true, breaks: false });

interface ExportModalProps {
  content: string;
  slug: string;
  onClose: () => void;
}

type ExportFormat = "html" | "text";

const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "html", label: "HTML" },
  { value: "text", label: "Plain Text" },
];

export function ExportModal({ content, slug, onClose }: ExportModalProps) {
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
    <ModalShell title="Export" onClose={onClose}>
      {/* Native radio group: one composite control, one tab stop, arrow
          navigation and accessibility for free; activation follows focus
          (native). Mirrors the CenterPane status radios. */}
      <div className="export-format-radios" role="radiogroup" aria-label="Export format">
        {EXPORT_FORMATS.map(({ value, label }) => (
          <label
            key={value}
            className={`export-format-radio${format === value ? " active" : ""}`}
          >
            <input
              type="radio"
              name="export-format"
              value={value}
              checked={format === value}
              onChange={() => setFormat(value)}
            />
            {label}
          </label>
        ))}
      </div>

      <pre className="export-preview">
        {output || (
          <span style={{ color: "var(--bm-text-faint)", fontStyle: "italic" }}>
            No content yet
          </span>
        )}
      </pre>

      <div className="export-actions">
        <button className="btn-export" onClick={handleCopy}>
          {copiedKey === "copy" ? (
            "✓ Copied"
          ) : (
            "Copy"
          )}
        </button>
        <button
          className="btn-primary"
          style={{ width: "auto" }}
          onClick={handleDownload}
          autoFocus
        >
          Download .{format === "html" ? "html" : "txt"}
        </button>
      </div>
    </ModalShell>
  );
}
