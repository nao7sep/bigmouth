import { useState } from "react";
import { PostPickerList } from "./PostPickerList";
import { usePostPicker } from "../hooks/usePostPicker";
import { useEscapeKey } from "../hooks/useEscapeKey";
import type { Target } from "../types";

interface NewPostModalProps {
  targets: Target[];
  supportedLanguages: string[];
  pubBatchSize: number;
  onClose: () => void;
  onCreate: (target: string, language: string, sourceId?: string) => void;
}

function resolveLanguage(
  lang: string | undefined,
  supportedLanguages: string[]
): string {
  if (lang && supportedLanguages.includes(lang)) return lang;
  if (supportedLanguages.includes("en")) return "en";
  return supportedLanguages[0] ?? "en";
}

export function NewPostModal({
  targets,
  supportedLanguages,
  pubBatchSize,
  onClose,
  onCreate,
}: NewPostModalProps) {
  useEscapeKey(onClose);
  const [selectedTarget, setSelectedTarget] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState(() =>
    resolveLanguage(undefined, supportedLanguages)
  );
  const [sourceId, setSourceId] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");

  const picker = usePostPicker(pubBatchSize);

  const handleTargetChange = (name: string) => {
    setSelectedTarget(name);
    const t = targets.find((t) => t.name === name);
    setSelectedLanguage(resolveLanguage(t?.defaultLanguage, supportedLanguages));
  };

  const handleCreate = () => {
    onCreate(selectedTarget || "default", selectedLanguage, sourceId || undefined);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 440 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>New Post</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <div className="form-field">
            <label className="form-label">Target</label>
            {targets.length > 0 ? (
              <select
                className="form-select"
                value={selectedTarget}
                onChange={(e) => handleTargetChange(e.target.value)}
              >
                <option value="" disabled>Please select…</option>
                {[...targets].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name} ({t.defaultLanguage})
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="form-input"
                type="text"
                value={selectedTarget}
                onChange={(e) => setSelectedTarget(e.target.value)}
                placeholder="default"
              />
            )}
          </div>

          <div className="form-field">
            <label className="form-label">Language</label>
            <select
              className="form-select"
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
            >
              {[...supportedLanguages].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
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
                  setSourceId(id);
                  setSourceTitle(title);
                  picker.setQuery("");
                }}
              />
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-toolbar" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-new-post"
            style={{ width: "auto" }}
            onClick={handleCreate}
            disabled={!selectedTarget}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
