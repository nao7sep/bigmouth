import { useEffect, useState } from "react";
import { fetchPosts } from "../api";
import type { PostSummary } from "../types";

interface SourcePickerModalProps {
  currentPostId: string;
  onSelect: (sourceId: string) => void;
  onClose: () => void;
}

export function SourcePickerModal({
  currentPostId,
  onSelect,
  onClose,
}: SourcePickerModalProps) {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchPosts(0, 200)
      .then((data) => {
        const all = [...data.drafts, ...data.ready, ...data.published];
        setPosts(all.filter((p) => p.frontMatter.id !== currentPostId));
      })
      .catch(() => {});
  }, [currentPostId]);

  const filtered = query.trim()
    ? posts.filter((p) => {
        const fm = p.frontMatter;
        const haystack = [fm.id, fm.target, fm.language, fm.title ?? ""]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query.toLowerCase());
      })
    : posts;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 520, maxHeight: "75vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Link Source Post</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div style={{ padding: "10px 20px 0" }}>
          <input
            className="search-input"
            placeholder="Search posts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        <div className="modal-body" style={{ overflowY: "auto" }}>
          {filtered.length === 0 ? (
            <p style={{ color: "#999", fontSize: 13 }}>No posts found</p>
          ) : (
            filtered.map((p) => {
              const fm = p.frontMatter;
              const label = fm.title ?? fm.id;
              const sub = `${fm.target} · ${fm.language} · ${fm.status}`;
              return (
                <div
                  key={fm.id}
                  className="source-picker-item"
                  onClick={() => { onSelect(fm.id); onClose(); }}
                >
                  <div className="source-picker-title">{label}</div>
                  <div className="source-picker-sub">{sub}</div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
