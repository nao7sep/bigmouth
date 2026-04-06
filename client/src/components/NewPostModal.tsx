import { useEffect, useState } from "react";
import { fetchPosts } from "../api";
import type { PostSummary, Target } from "../types";

interface NewPostModalProps {
  targets: Target[];
  supportedLanguages: string[];
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
  onClose,
  onCreate,
}: NewPostModalProps) {
  const [selectedTarget, setSelectedTarget] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState(() =>
    resolveLanguage(undefined, supportedLanguages)
  );

  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");

  useEffect(() => {
    fetchPosts(0, 500)
      .then((data) => {
        setPosts([...data.drafts, ...data.ready, ...data.published]);
      })
      .catch(() => {});
  }, []);

  const handleTargetChange = (name: string) => {
    setSelectedTarget(name);
    const t = targets.find((t) => t.name === name);
    setSelectedLanguage(resolveLanguage(t?.defaultLanguage, supportedLanguages));
  };

  const filtered = query.trim()
    ? posts.filter((p) => {
        const fm = p.frontMatter;
        const haystack = [fm.id, fm.target, fm.language, fm.title ?? ""]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query.toLowerCase());
      })
    : posts;

  const handleSelectSource = (id: string, title: string) => {
    setSourceId(id);
    setSourceTitle(title);
    setQuery("");
  };

  const handleCreate = () => {
    const tName = selectedTarget || "default";
    onCreate(tName, selectedLanguage, sourceId || undefined);
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
            <select
              className="form-select"
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
            >
              {supportedLanguages.map((lang) => (
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
              <>
                <input
                  className="form-input"
                  placeholder="Search posts…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query.trim() && (
                  <div className="source-picker-list">
                    {filtered.length === 0 ? (
                      <p className="source-picker-empty">No posts found</p>
                    ) : (
                      filtered.map((p) => {
                        const fm = p.frontMatter;
                        const label = fm.title ?? fm.id;
                        const sub = `${fm.target} · ${fm.language} · ${fm.status}`;
                        return (
                          <div
                            key={fm.id}
                            className="source-picker-item"
                            onClick={() => handleSelectSource(fm.id, label)}
                          >
                            <div className="source-picker-title">{label}</div>
                            <div className="source-picker-sub">{sub}</div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </>
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
