import { useCallback, useMemo } from "react";
import type { PostPickerState } from "../hooks/usePostPicker";
import { getPostTitle } from "../util/postTitle";
import { useComposing, isComposingKeyboardEvent } from "../hooks/useComposing";
import { usePostListbox, type PostListRow } from "../hooks/usePostListbox";

const PAGE_SIZE = 10;

interface PostPickerListProps extends PostPickerState {
  onSelect: (id: string, title: string) => void;
  autoFocus?: boolean;
}

// A filterable post chooser. The filter input and the results are two tab stops:
// the input (a synchronous local field), then the results as one listbox per the
// composite-control conventions — arrow keys move the cursor, type-ahead jumps
// by title, Enter/click commits, and ArrowDown from the filter drops into the
// list. There is no committed selection (each pick is one-shot), so the first
// row rests as the cursor via `autoActivateFirst`.
export function PostPickerList({
  posts,
  hasMore,
  loadingMore,
  loadMore,
  query,
  setQuery,
  onSelect,
  autoFocus,
  error,
}: PostPickerListProps) {
  const { composingRef, handlers } = useComposing();

  const rows: PostListRow[] = useMemo(
    () => posts.map((p) => ({ id: p.frontMatter.id, label: getPostTitle(p.frontMatter) })),
    [posts],
  );

  const onActivate = useCallback(
    (id: string) => {
      const post = posts.find((p) => p.frontMatter.id === id);
      if (post) onSelect(id, getPostTitle(post.frontMatter));
    },
    [posts, onSelect],
  );

  const { listboxProps, getRowProps, activeId } = usePostListbox({
    rows,
    selectedId: null,
    onActivate,
    pageSize: PAGE_SIZE,
    composingRef,
    autoActivateFirst: true,
  });

  return (
    <>
      <input
        className="form-input"
        style={{ marginBottom: 4 }}
        placeholder="Filter posts…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus={autoFocus}
        onCompositionStart={handlers.onCompositionStart}
        onCompositionEnd={handlers.onCompositionEnd}
        onKeyDown={(e) => {
          if (isComposingKeyboardEvent(composingRef, e)) return;
          // ArrowDown hands focus off to the results so the keyboard flow is
          // filter → pick without a Tab in between. The listbox container is the
          // focus holder; autoActivateFirst already rests its cursor on row 0.
          if (e.key === "ArrowDown" && listboxProps.ref.current) {
            e.preventDefault();
            listboxProps.ref.current.focus();
          }
        }}
      />
      <div className="post-picker-list" aria-label="Posts" {...listboxProps}>
        {posts.length === 0 && !error ? (
          <p className="post-picker-empty">No posts found</p>
        ) : (
          posts.map((p) => {
            const fm = p.frontMatter;
            const title = getPostTitle(fm);
            const sub = `${fm.target} · ${fm.language} · ${fm.status}`;
            return (
              <div
                key={fm.id}
                className={`post-picker-item${fm.id === activeId ? " active" : ""}`}
                onCompositionStart={handlers.onCompositionStart}
                onCompositionEnd={handlers.onCompositionEnd}
                {...getRowProps(fm.id)}
              >
                <div className="post-picker-title">{title}</div>
                <div className="post-picker-sub">{sub}</div>
              </div>
            );
          })
        )}
        {error && <p className="settings-field-error">{error}</p>}
        {hasMore && (
          <button
            // Pointer-only: not a tab stop, so it never breaks the listbox's
            // single tab stop.
            tabIndex={-1}
            className="btn-toolbar"
            style={{ width: "100%", marginTop: 4 }}
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load More"}
          </button>
        )}
      </div>
    </>
  );
}
