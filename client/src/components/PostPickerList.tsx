import type { PostPickerState } from "../hooks/usePostPicker";
import { getPostTitle } from "../util/postTitle";

interface PostPickerListProps extends PostPickerState {
  onSelect: (id: string, title: string) => void;
  autoFocus?: boolean;
}

export function PostPickerList({
  posts,
  hasMore,
  loadMore,
  query,
  setQuery,
  onSelect,
  autoFocus,
}: PostPickerListProps) {
  return (
    <>
      <input
        className="form-input"
        style={{ marginBottom: 4 }}
        placeholder="Filter posts…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus={autoFocus}
      />
      <div className="post-picker-list">
        {posts.length === 0 ? (
          <p className="post-picker-empty">No posts found</p>
        ) : (
          posts.map((p) => {
            const fm = p.frontMatter;
            const title = getPostTitle(fm);
            const sub = `${fm.target} · ${fm.language} · ${fm.status}`;
            return (
              <div
                key={fm.id}
                className="post-picker-item"
                onClick={() => onSelect(fm.id, title)}
              >
                <div className="post-picker-title">{title}</div>
                <div className="post-picker-sub">{sub}</div>
              </div>
            );
          })
        )}
        {hasMore && (
          <button
            className="btn-toolbar"
            style={{ width: "100%", marginTop: 4 }}
            onClick={loadMore}
          >
            Load More
          </button>
        )}
      </div>
    </>
  );
}
