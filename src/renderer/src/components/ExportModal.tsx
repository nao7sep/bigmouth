import { useMemo, useState } from "react";
import { Marked } from "marked";
import removeMd from "remove-markdown";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { ModalShell } from "./ModalShell";
import { CheckIcon } from "./Icon";
import { OperationalResult } from "./OperationalResult";
import { useI18n } from "../i18n/I18nContext";
import type { MessageKey } from "@shared/i18n/catalogues";

const marked = new Marked({ gfm: true, breaks: false });

interface ExportModalProps {
  content: string;
  slug: string;
  onClose: () => void;
}

type ExportFormat = "html" | "text";

const EXPORT_FORMATS: { value: ExportFormat; label: MessageKey }[] = [
  { value: "html", label: "export.html" },
  { value: "text", label: "export.plainText" },
];

export function ExportModal({ content, slug, onClose }: ExportModalProps) {
  const { t, text } = useI18n();
  const [format, setFormat] = useState<ExportFormat>("html");
  const { copiedKey, copy, copyErrors, dismissCopyError } = useCopyFeedback();

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
    <ModalShell title={t("export.title")} onClose={onClose}>
      {/* Native radio group: one composite control, one tab stop, arrow
          navigation and accessibility for free; activation follows focus
          (native). Mirrors the CenterPane status radios. */}
      <div className="modal-strip">
      <div className="export-format-radios" role="radiogroup" aria-label={t("export.format")}>
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
            {t(label)}
          </label>
        ))}
      </div>
      </div>

      <div className="modal-body">
      <pre
        className="export-preview"
        role="region"
        aria-label={t("export.preview")}
        tabIndex={0}
      >
        {output || (
          <span style={{ color: "var(--bm-text-faint)", fontStyle: "italic" }}>
            {t("export.empty")}
          </span>
        )}
      </pre>

      {copyErrors.copy && (
        <OperationalResult
          severity="error"
          className="modal-result modal-footer-result"
          onDismiss={() => dismissCopyError("copy")}
          dismissClassName="modal-result-dismiss"
        >
          {text(copyErrors.copy)}
        </OperationalResult>
      )}

      </div>

      <div className="modal-footer">
        <button className="btn-action" onClick={onClose}>
          {t("common.close")}
        </button>
        <button className="btn-action" onClick={handleCopy}>
          {copiedKey === "copy" ? (
            <>
              <CheckIcon /> {t("common.copied")}
            </>
          ) : (
            t("common.copy")
          )}
        </button>
        <button
          className="btn-primary"
          onClick={handleDownload}
          autoFocus
        >
          {t("export.download", { extension: format === "html" ? ".html" : ".txt" })}
        </button>
      </div>
    </ModalShell>
  );
}
