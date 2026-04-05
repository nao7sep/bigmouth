import { useState } from "react";
import type { PostSummary, Target } from "../types";

interface NewPostModalProps {
  targets: Target[];
  allPosts: PostSummary[];
  onClose: () => void;
  onCreate: (target: string, language: string, sourceId?: string) => void;
}

export function NewPostModal({
  targets,
  allPosts,
  onClose,
  onCreate,
}: NewPostModalProps) {
  const [selectedTarget, setSelectedTarget] = useState(
    targets.length > 0 ? targets[0].name : ""
  );
  const [sourceId, setSourceId] = useState("");

  const target = targets.find((t) => t.name === selectedTarget);
  const language = target?.defaultLanguage ?? "en";

  const handleCreate = () => {
    const tName = selectedTarget || "default";
    onCreate(tName, language, sourceId || undefined);
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        style={{ width: 420 }}
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
                onChange={(e) => setSelectedTarget(e.target.value)}
              >
                {targets.map((t) => (
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
            <input
              className="form-input"
              type="text"
              value={language}
              disabled
            />
          </div>

          <div className="form-field">
            <label className="form-label">Source post (optional)</label>
            <select
              className="form-select"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="">None</option>
              {allPosts.map((p) => {
                const fm = p.frontMatter;
                const label = fm.title || fm.slug || fm.id;
                return (
                  <option key={fm.id} value={fm.id}>
                    {label} ({fm.target})
                  </option>
                );
              })}
            </select>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn-toolbar" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-new-post" style={{ width: "auto" }} onClick={handleCreate}>
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
