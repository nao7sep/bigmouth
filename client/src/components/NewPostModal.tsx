import { useState } from "react";
import { PostPickerList } from "./PostPickerList";
import { usePostPicker } from "../hooks/usePostPicker";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { ConfirmModal } from "./ConfirmModal";
import type { Target } from "../types";

interface NewPostModalProps {
  targets: Target[];
  supportedLanguages: string[];
  pubBatchSize: number;
  onClose: () => void;
  onCreate: (target: string, language: string, sourceId?: string) => Promise<void> | void;
}

function resolveLanguage(
  lang: string | undefined,
  supportedLanguages: string[]
): string {
  if (lang && supportedLanguages.includes(lang)) return lang;
  if (supportedLanguages.includes("en")) return "en";
  return supportedLanguages[0] ?? "";
}

export function NewPostModal({
  targets,
  supportedLanguages,
  pubBatchSize,
  onClose,
  onCreate,
}: NewPostModalProps) {
  const [selectedTarget, setSelectedTarget] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState(() =>
    resolveLanguage(undefined, supportedLanguages)
  );
  const [sourceId, setSourceId] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const initialLanguage = resolveLanguage(undefined, supportedLanguages);
  const isDirty =
    selectedTarget !== "" ||
    selectedLanguage !== initialLanguage ||
    sourceId !== "";

  const handleRequestClose = () => {
    if (showDiscardConfirm) return;
    if (isDirty) {
      setShowDiscardConfirm(true);
    } else {
      onClose();
    }
  };

  useEscapeKey(handleRequestClose);

  const picker = usePostPicker(pubBatchSize);
  const sortedTargets = [...targets].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  const sortedLanguages = [...supportedLanguages].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
  const hasTargets = sortedTargets.length > 0;
  const hasLanguages = sortedLanguages.length > 0;

  const handleTargetChange = (name: string) => {
    setCreateError(null);
    setSelectedTarget(name);
    const t = targets.find((t) => t.name === name);
    setSelectedLanguage(resolveLanguage(t?.defaultLanguage, supportedLanguages));
  };

  const handleCreate = async () => {
    if (!hasTargets) {
      setCreateError("No targets configured. Add one in Settings before creating a post.");
      return;
    }
    if (!hasLanguages) {
      setCreateError("No supported languages configured. Add one in Settings before creating a post.");
      return;
    }
    if (!selectedTarget) {
      setCreateError("Select a target before creating a post.");
      return;
    }
    if (!selectedLanguage || !supportedLanguages.includes(selectedLanguage)) {
      setCreateError("Select a supported language before creating a post.");
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      await onCreate(selectedTarget, selectedLanguage, sourceId || undefined);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create post.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={handleRequestClose}>
      <div
        className="modal"
        style={{ width: 440 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>New Post</h2>
          <button className="modal-close" onClick={handleRequestClose}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <div className="form-field">
            <label className="form-label">Target</label>
            {hasTargets ? (
              <select
                className="form-select"
                value={selectedTarget}
                onChange={(e) => handleTargetChange(e.target.value)}
                autoFocus
              >
                <option value="" disabled>Please select…</option>
                {sortedTargets.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name} ({t.defaultLanguage})
                  </option>
                ))}
              </select>
            ) : (
              <p className="settings-field-error">No targets configured.</p>
            )}
          </div>

          <div className="form-field">
            <label className="form-label">Language</label>
            {hasLanguages ? (
              <select
                className="form-select"
                value={selectedLanguage}
                onChange={(e) => {
                  setCreateError(null);
                  setSelectedLanguage(e.target.value);
                }}
              >
                {sortedLanguages.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            ) : (
              <p className="settings-field-error">
                No supported languages configured. Add one in Settings → General before creating a post.
              </p>
            )}
          </div>

          <div className="form-field">
            <label className="form-label">Source post (optional)</label>
            {sourceId ? (
              <div className="source-selected">
                <span className="source-selected-title">{sourceTitle}</span>
                <button
                  className="btn-toolbar"
                  onClick={() => { setSourceId(""); setSourceTitle(""); }}
                >
                  Unlink
                </button>
              </div>
            ) : (
              <PostPickerList
                {...picker}
                onSelect={(id, title) => {
                  setCreateError(null);
                  setSourceId(id);
                  setSourceTitle(title);
                  picker.setQuery("");
                }}
              />
            )}
          </div>
          {createError && <p className="settings-field-error">{createError}</p>}
        </div>
        <div className="modal-footer">
          <button className="btn-toolbar" onClick={handleRequestClose}>
            Cancel
          </button>
          <button
            className="btn-new-post"
            style={{ width: "auto" }}
            onClick={handleCreate}
            disabled={!hasTargets || !hasLanguages || !selectedTarget || !selectedLanguage || creating}
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
        {showDiscardConfirm && (
          <ConfirmModal
            title="Discard new post?"
            message="You have unsaved selections. Discard them and close?"
            confirmLabel="Discard"
            cancelLabel="Keep Editing"
            danger
            onConfirm={() => { setShowDiscardConfirm(false); onClose(); }}
            onCancel={() => setShowDiscardConfirm(false)}
          />
        )}
      </div>
    </div>
  );
}
