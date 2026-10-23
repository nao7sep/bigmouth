import { useCallback, useMemo } from "react";
import type { PostPickerState } from "../hooks/usePostPicker";
import { getPostTitle } from "../util/postTitle";
import { useComposing, isComposingKeyboardEvent } from "../hooks/useComposing";
import { usePostListbox, type PostListRow } from "../hooks/usePostListbox";
import { OperationalResult } from "./OperationalResult";
import { POST_STATUS_LABELS } from "@shared/postStatus";
import { useI18n } from "../i18n/I18nContext";

interface PostPickerListProps extends PostPickerState {
  onSelect: (id: string, title: string) => void;
  selectedId?: string | null;
  autoFocus?: boolean;
}

// A filterable post chooser. The filter input and results each have a tab stop;
// Load More, when present, follows them. The results form one listbox per the
// composite-control conventions — arrow keys move the cursor, type-ahead jumps
// by title, Enter/click commits, and ArrowDown from the filter drops into the
// list. The current source, when eligible, initializes the cursor; otherwise
// the first row does. Hover never changes that initialized keyboard target.
export function PostPickerList({
  posts,
  hasMore,
  loading,
  loadingMore,
  loadMore,
  query,
  setQuery,
  onSelect,
  selectedId = null,
  autoFocus,
  error,
}: PostPickerListProps) {
  const { t, text } = useI18n();
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
    selectedId,
    onActivate,
    composingRef,
    autoActivateFirst: true,
  });

  return (
    <>
      <input
        className="form-input"
        style={{ marginBottom: 4 }}
        placeholder={t("picker.filter")}
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
      <div className="post-picker-list" aria-label={t("left.posts")} {...listboxProps}>
        {loading ? (
          <p className="post-picker-empty" role="status">{t("common.loading")}</p>
        ) : posts.length === 0 && !error ? (
          <p className="post-picker-empty">{t("picker.empty")}</p>
        ) : (
          posts.map((p) => {
            const fm = p.frontMatter;
            const title = getPostTitle(fm);
            const sub = t("picker.postSub", {
              target: fm.target,
              language: fm.language,
              status: t(POST_STATUS_LABELS[fm.status]),
            });
            return (
              <div
                key={fm.id}
                className={`post-picker-item${fm.id === activeId ? " active" : ""}${fm.id === selectedId ? " selected" : ""}`}
                onCompositionStart={handlers.onCompositionStart}
                onCompositionEnd={handlers.onCompositionEnd}
                {...getRowProps(fm.id)}
              >
                {/* One line each, cut at the end: linking or opening the post
                    shows its whole title in Metadata, and Settings' Targets
                    tab shows every target name whole. */}
                <div className="post-picker-title" title={title}>{title}</div>
                <div className="post-picker-sub" title={sub}>{sub}</div>
              </div>
            );
          })
        )}
        {error && (
          <OperationalResult severity="error" className="modal-result">
            {text(error)}
          </OperationalResult>
        )}
        {hasMore && (
          <button
            className="btn-toolbar"
            style={{ width: "100%", marginTop: 4 }}
            onClick={loadMore}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={loadingMore}
          >
            {loadingMore ? t("common.loading") : t("picker.loadMore")}
          </button>
        )}
      </div>
    </>
  );
}
