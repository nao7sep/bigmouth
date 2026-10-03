import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
} from "react";

import { DIVIDER, RECORDS_DETAIL_MIN_WIDTH, RECORDS_LIST_WIDTH } from "@shared/layout";
import {
  RECORD_KINDS,
  RECORD_LEVEL_FILTERS,
  type RecordDetail,
  type RecordKind,
  type RecordLevel,
  type RecordLevelFilter,
  type RecordSources,
  type RecordsQuery,
  type RecordSummary,
} from "@shared/records";
import {
  onRecordsChanged,
  readRecordDetail,
  readRecordSources,
  readRecordsPage,
  reportProblem,
  updateUiState,
} from "../api";
import { useComposing } from "../hooks/useComposing";
import { usePostListbox, type PostListRow } from "../hooks/usePostListbox";
import { useI18n } from "../i18n/I18nContext";
import { clamp, clampPaneWidth } from "../paneConstants";
import {
  KIND_LABELS,
  LEVEL_FILTER_LABELS,
  LEVEL_LABELS,
  cursorAfter,
  durationSeconds,
  mergeNewestPage,
  prettyJson,
  purposeLabel,
  recordKey,
} from "./recordFormat";

type Filters = Omit<RecordsQuery, "after">;

const NO_RECORDS: RecordSummary[] = [];
const NO_FILTERS: Filters = { session: null, kind: null, level: null, search: "" };
const SEARCH_DELAY_MS = 300;
// New records are read at most this often while they keep arriving.
const LIVE_INTERVAL_MS = 1000;
const PAGE_STEP = 10;
// Everything beside the list pane on its row: the divider and the detail pane's minimum.
const LIST_SIBLING_MIN = DIVIDER + RECORDS_DETAIL_MIN_WIDTH;

type ListState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; records: RecordSummary[]; more: boolean; loadingMore: boolean; moreFailed: boolean };

type DetailState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; record: RecordDetail };

type Selection = { kind: RecordKind; id: number };

const LEVEL_CLASSES: Record<RecordLevel, string> = {
  error: "records-level records-level--error",
  warn: "records-level records-level--warn",
  info: "records-level",
  debug: "records-level",
};

// Within about one screen of the end of what is loaded.
function nearEnd(scroll: HTMLElement): boolean {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= scroll.clientHeight;
}

function atTop(scroll: HTMLElement): boolean {
  return scroll.scrollTop < 1;
}

export function RecordsWindow({ initialListWidth }: { initialListWidth: number }): ReactElement {
  const { t, locale } = useI18n();
  const { composingRef, handlers: compositionHandlers } = useComposing();
  const [sources, setSources] = useState<RecordSources | null>(null);
  const [sourceReads, setSourceReads] = useState(0);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [selected, setSelected] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "none" });
  // The list pane's INTENT width; the shown width is clamped to the window.
  const [listIntent, setListIntent] = useState(initialListWidth);
  const [shellWidth, setShellWidth] = useState<number | null>(null);
  const listGeneration = useRef(0);
  // The busy claim for the next page (PLAYBOOK, Own the work in flight).
  const fetchingMore = useRef(false);
  // The filters the current list was read for, for the live reads below.
  const filtersRef = useRef(filters);
  // New records arrived while the list was scrolled away from the top.
  const newestPending = useRef(false);
  // A failed read is itself logged as a record, whose signal would start the
  // next read; live reads stop after a failure and resume after a read succeeds.
  const liveSuspended = useRef(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  // The listbox, which is also the list's scroll box.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeDragRef = useRef<(() => void) | null>(null);

  const rowTime = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }),
    [locale],
  );

  useEffect(() => {
    document.title = t("records.title");
  }, [t]);

  // Pane sizing: window-conventions, Content-based minimum size.
  useEffect(() => {
    const shell = shellRef.current;
    if (shell === null) return;
    setShellWidth(shell.clientWidth);
    const observer = new ResizeObserver(() => setShellWidth(shell.clientWidth));
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);
  const listWidth =
    shellWidth === null
      ? listIntent
      : clampPaneWidth(listIntent, RECORDS_LIST_WIDTH.min, RECORDS_LIST_WIDTH.max, shellWidth, LIST_SIBLING_MIN);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((current) => (current.search === searchText ? current : { ...current, search: searchText }));
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    let cancelled = false;
    readRecordSources().then(
      (next) => {
        if (!cancelled) setSources(next);
      },
      (err: unknown) => {
        liveSuspended.current = true;
        reportProblem("renderer: record sources read failed", err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sourceReads]);

  // A page applies only while the filters it was read for are still the
  // newest ones asked for.
  useEffect(() => {
    filtersRef.current = filters;
    const generation = ++listGeneration.current;
    fetchingMore.current = false;
    newestPending.current = false;
    setList({ status: "loading" });
    readRecordsPage({ ...filters, after: null }).then(
      (page) => {
        if (generation !== listGeneration.current) return;
        liveSuspended.current = false;
        setList({ status: "ready", records: page.records, more: page.more, loadingMore: false, moreFailed: false });
      },
      (err: unknown) => {
        if (generation !== listGeneration.current) return;
        liveSuspended.current = true;
        reportProblem("renderer: records read failed", err);
        setList({ status: "failed" });
      },
    );
  }, [filters]);

  // The newest page read again for new records. It joins the rows already
  // shown rather than replacing them, so the list never falls back to the
  // loading note and the pages already read stay. It reads only refs, so one
  // copy serves the live subscription below.
  const readNewest = useCallback((): void => {
    const generation = listGeneration.current;
    readRecordsPage({ ...filtersRef.current, after: null }).then(
      (page) => {
        if (generation !== listGeneration.current) return;
        liveSuspended.current = false;
        setList((current) =>
          current.status === "ready"
            ? { ...current, ...mergeNewestPage(current.records, current.more, page) }
            : { status: "ready", records: page.records, more: page.more, loadingMore: false, moreFailed: false },
        );
      },
      (err: unknown) => {
        if (generation !== listGeneration.current) return;
        liveSuspended.current = true;
        reportProblem("renderer: records read failed", err);
      },
    );
  }, []);

  // A stored record reaches the list at once while it is scrolled to the top;
  // otherwise it waits until the list is back there, so the list never moves
  // under the reader.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onRecordsChanged(() => {
      if (timer !== null || liveSuspended.current) return;
      timer = setTimeout(() => {
        timer = null;
        setSourceReads((count) => count + 1);
        const scroll = scrollRef.current;
        if (scroll === null || atTop(scroll)) readNewest();
        else newestPending.current = true;
      }, LIVE_INTERVAL_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [readNewest]);

  const selectedKey = selected === null ? null : recordKey(selected);

  useEffect(() => {
    if (selected === null) {
      setDetail({ status: "none" });
      return;
    }
    let cancelled = false;
    setDetail({ status: "loading" });
    readRecordDetail(selected.kind, selected.id).then(
      (record) => {
        if (!cancelled) setDetail(record === null ? { status: "failed" } : { status: "ready", record });
      },
      (err: unknown) => {
        if (cancelled) return;
        reportProblem("renderer: record read failed", err);
        setDetail({ status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
    // The selection is compared by its key, not by the object holding it.
  }, [selectedKey]);

  // Loading more: composite-control-conventions, Integration Points. A failed
  // page is read again when the end is reached again.
  const loadMore = (): void => {
    if (list.status !== "ready" || !list.more || fetchingMore.current) return;
    fetchingMore.current = true;
    const generation = listGeneration.current;
    setList((current) => (current.status === "ready" ? { ...current, loadingMore: true, moreFailed: false } : current));
    readRecordsPage({ ...filters, after: cursorAfter(list.records) }).then(
      (page) => {
        if (generation !== listGeneration.current) return;
        fetchingMore.current = false;
        liveSuspended.current = false;
        setList((current) =>
          current.status === "ready"
            ? { ...current, records: [...current.records, ...page.records], more: page.more, loadingMore: false }
            : current,
        );
      },
      (err: unknown) => {
        if (generation !== listGeneration.current) return;
        fetchingMore.current = false;
        liveSuspended.current = true;
        reportProblem("renderer: records read failed", err);
        setList((current) => (current.status === "ready" ? { ...current, loadingMore: false, moreFailed: true } : current));
      },
    );
  };

  // A page that leaves the list short of the end reads the next one; a failed
  // page waits for the reader instead.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (list.status !== "ready" || list.loadingMore || list.moreFailed || scroll === null) return;
    if (nearEnd(scroll)) loadMore();
    // Only a new list state can change what is loaded.
  }, [list]);

  const onListScroll = (): void => {
    const scroll = scrollRef.current;
    if (scroll === null) return;
    if (newestPending.current && atTop(scroll)) {
      newestPending.current = false;
      readNewest();
    }
    if (nearEnd(scroll)) loadMore();
  };

  const records = list.status === "ready" ? list.records : NO_RECORDS;
  const rows: PostListRow[] = useMemo(
    () => records.map((record) => ({ id: recordKey(record), label: record.title })),
    [records],
  );
  const byKey = useMemo(() => new Map(records.map((record) => [recordKey(record), record])), [records]);

  const onActivate = useCallback(
    (key: string) => {
      const record = byKey.get(key);
      if (record !== undefined) setSelected({ kind: record.kind, id: record.id });
    },
    [byKey],
  );

  // The list is one listbox (composite-control-conventions, Listbox); the
  // selection follows focus.
  const { listboxProps, getRowProps, activeId } = usePostListbox({
    rows,
    selectedId: selectedKey,
    onActivate,
    pageSize: PAGE_STEP,
    composingRef,
    followFocus: true,
  });

  // Moving past the last row loaded reads the next page.
  const onListKeyDown = (event: ReactKeyboardEvent): void => {
    const index = activeId === null ? -1 : rows.findIndex((row) => row.id === activeId);
    listboxProps.onKeyDown(event);
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target =
      event.key === "ArrowDown" ? index + 1 : event.key === "PageDown" ? Math.max(0, index) + PAGE_STEP : event.key === "End" ? rows.length - 1 : -1;
    if (rows.length > 0 && target >= rows.length - 1) loadMore();
  };

  // Drag intent: window-conventions, Content-based minimum size. Only a drag
  // persists, and it persists the intent.
  const startDrag = (event: ReactMouseEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = listWidth;
    let dragged: number | null = null;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (move: MouseEvent): void => {
      dragged = clamp(startWidth + move.clientX - startX, RECORDS_LIST_WIDTH.min, RECORDS_LIST_WIDTH.max);
      setListIntent(dragged);
    };
    const onUp = (): void => {
      endDrag();
      if (dragged === null) return;
      void updateUiState({ recordsListWidth: dragged }).catch((err: unknown) =>
        reportProblem("renderer: records list width save failed", err),
      );
    };
    const endDrag = (): void => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      activeDragRef.current = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    activeDragRef.current = endDrag;
  };
  useEffect(() => () => activeDragRef.current?.(), []);

  const launchLabel = (session: string): string => {
    const time = rowTime.format(new Date(session));
    return session === sources?.currentSession ? t("records.thisLaunch", { time }) : time;
  };

  const listNote =
    list.status === "failed" ? (
      <p className="records-note records-note--error" role="alert">{t("records.loadFailed")}</p>
    ) : list.status === "loading" ? (
      <p className="records-note">{t("records.loading")}</p>
    ) : records.length === 0 ? (
      <p className="records-note">{t("records.empty")}</p>
    ) : null;

  return (
    <div
      ref={shellRef}
      className="records-shell"
      style={{ "--records-list-width": `${listWidth}px` } as CSSProperties}
    >
      <section className="records-list-pane" aria-label={t("records.title")}>
        <div className="records-filters">
          <input
            type="search"
            className="form-input"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder={t("records.search")}
            aria-label={t("records.search")}
          />
          <div className="records-filters-row">
            <FilterSelect
              label={t("records.kind")}
              value={filters.kind}
              allLabel={t("records.allKinds")}
              options={RECORD_KINDS.map((kind) => ({ value: kind, label: t(KIND_LABELS[kind]) }))}
              onChange={(kind) => setFilters({ ...filters, kind: kind as RecordKind | null })}
            />
            <FilterSelect
              label={t("records.level")}
              value={filters.level}
              allLabel={t("records.allLevels")}
              options={RECORD_LEVEL_FILTERS.map((level) => ({ value: level, label: t(LEVEL_FILTER_LABELS[level]) }))}
              onChange={(level) => setFilters({ ...filters, level: level as RecordLevelFilter | null })}
            />
          </div>
          <FilterSelect
            label={t("records.launch")}
            value={filters.session}
            allLabel={t("records.allLaunches")}
            options={(sources?.sessions ?? []).map((session) => ({ value: session, label: launchLabel(session) }))}
            onChange={(session) => setFilters({ ...filters, session })}
          />
        </div>
        <div
          {...listboxProps}
          ref={(element) => {
            scrollRef.current = element;
            listboxProps.ref.current = element;
          }}
          onKeyDown={onListKeyDown}
          onCompositionStart={compositionHandlers.onCompositionStart}
          onCompositionEnd={compositionHandlers.onCompositionEnd}
          className="records-list"
          aria-label={t("records.title")}
          aria-busy={list.status === "loading"}
          onScroll={onListScroll}
        >
          {listNote}
          {records.map((record) => {
            const key = recordKey(record);
            return (
              <div
                key={key}
                className={`records-row${key === selectedKey ? " selected" : ""}${key === activeId ? " active" : ""}`}
                {...getRowProps(key)}
              >
                <div className="records-row-meta">
                  <span>{rowTime.format(new Date(record.time))}</span>
                  <span className={LEVEL_CLASSES[record.level]}>{t(LEVEL_LABELS[record.level])}</span>
                  {record.kind === "provider-call" ? <span>{t(KIND_LABELS[record.kind])}</span> : null}
                </div>
                <div className="records-row-title">{record.title}</div>
                {record.text ? <div className="records-row-text">{record.text}</div> : null}
              </div>
            );
          })}
          {list.status === "ready" && list.loadingMore ? (
            <p className="records-note">{t("records.loading")}</p>
          ) : null}
          {list.status === "ready" && list.moreFailed ? (
            <p className="records-note records-note--error" role="alert">{t("records.loadFailed")}</p>
          ) : null}
        </div>
      </section>
      <div className="pane-divider" onMouseDown={startDrag} />
      <section className="records-detail-pane" aria-busy={detail.status === "loading"}>
        {detail.status === "ready" ? (
          <RecordDetailView record={detail.record} sources={sources} launchLabel={launchLabel} />
        ) : (
          <p className={`records-note${detail.status === "failed" ? " records-note--error" : ""}`}>
            {detail.status === "failed" ? t("records.detailFailed") : detail.status === "none" ? t("records.noSelection") : null}
          </p>
        )}
      </section>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  allLabel,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  allLabel: string;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}): ReactElement {
  // A chosen value the sources no longer list stays selectable until changed.
  const shown = value === null || options.some((option) => option.value === value)
    ? options
    : [{ value, label: value }, ...options];
  return (
    <select
      className="form-select"
      aria-label={label}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
    >
      <option value="">{allLabel}</option>
      {shown.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

function RecordDetailView({
  record,
  sources,
  launchLabel,
}: {
  record: RecordDetail;
  sources: RecordSources | null;
  launchLabel: (session: string) => string;
}): ReactElement {
  const { t, locale } = useI18n();
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
      }),
    [locale],
  );
  const secondsFormat = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "second",
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      }),
    [locale],
  );
  const time = (value: string): string => timeFormat.format(new Date(value));
  const level: RecordLevel = record.kind === "log" ? record.level : record.error === null ? "info" : "error";
  const workspaceName =
    record.workspaceId === null ? null : (sources?.workspaces.find((ws) => ws.id === record.workspaceId)?.name ?? null);

  const fields: { label: string; value: ReactNode }[] = [];
  const add = (label: string, value: ReactNode | null): void => {
    if (value !== null) fields.push({ label, value });
  };
  if (record.kind === "log") {
    add(t("records.time"), time(record.time));
  } else {
    add(t("records.started"), time(record.startedAt));
    add(t("records.finished"), time(record.finishedAt));
    add(t("records.duration"), secondsFormat.format(durationSeconds(record.startedAt, record.finishedAt)));
    add(t("records.provider"), <code>{record.provider}</code>);
    const purpose = purposeLabel(record.purpose);
    add(t("records.purpose"), purpose === null ? <code>{record.purpose}</code> : t(purpose));
  }
  add(
    t("records.workspace"),
    record.workspaceId === null ? null : (
      <>
        {workspaceName === null ? null : <span>{workspaceName}</span>}
        <code>{record.workspaceId}</code>
      </>
    ),
  );
  add(t("records.post"), record.postId === null ? null : <code>{record.postId}</code>);
  add(t("records.launch"), launchLabel(record.session));

  const blocks: { label: string; text: string }[] = [];
  if (record.kind === "log") {
    blocks.push({ label: t("records.event"), text: prettyJson(record.event) });
  } else {
    blocks.push({ label: t("records.request"), text: prettyJson(record.request) });
    if (record.response !== null) blocks.push({ label: t("records.response"), text: prettyJson(record.response) });
    if (record.error !== null) blocks.push({ label: t("records.error"), text: prettyJson(record.error) });
  }

  return (
    <>
      <div className="records-detail-header">
        <h2 className="records-detail-title">
          {record.kind === "log" ? record.message : `${record.provider} ${record.purpose}`}
        </h2>
        <div className="records-detail-labels">
          <span className={LEVEL_CLASSES[level]}>{t(LEVEL_LABELS[level])}</span>
          <span>{t(KIND_LABELS[record.kind])}</span>
        </div>
      </div>
      <div className="records-detail-body" role="region" tabIndex={0} aria-label={t("records.details")}>
        <dl className="records-meta">
          {fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
        {blocks.map((block) => (
          <section key={block.label} className="records-block">
            <h3 className="records-block-label">{block.label}</h3>
            <pre className="records-block-text">{block.text}</pre>
          </section>
        ))}
      </div>
    </>
  );
}
