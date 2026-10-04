import type { MessageKey } from "@shared/i18n/catalogues";
import type {
  LogRecordDetail,
  RecordCursor,
  RecordKind,
  RecordLevel,
  RecordLevelFilter,
  RecordsPage,
  RecordSummary,
} from "@shared/records";

export function recordKey(record: { kind: RecordKind; id: number }): string {
  return `${record.kind}:${record.id}`;
}

// A stored value with nothing in it, which gets no block.
function isEmptyValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

// A block's text: stored JSON indented for reading, and text that is not JSON
// as it is; null when the value holds nothing, so the block is left out.
export function blockText(text: string | null): string | null {
  if (text === null || text.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  return isEmptyValue(value) ? null : JSON.stringify(value, null, 2);
}

// A log record's Event block: the fields of its emitted line that the detail
// pane does not already show, or null when none remain. A field is left out
// only when it holds the value shown; the logger takes the workspace from
// either `workspace` or `workspaceId`.
export function logEventText(record: LogRecordDetail): string | null {
  let line: unknown;
  try {
    line = JSON.parse(record.event);
  } catch {
    return blockText(record.event);
  }
  if (line === null || typeof line !== "object" || Array.isArray(line)) return blockText(record.event);
  const shown: Readonly<Record<string, unknown>> = {
    time: record.time,
    level: record.level,
    message: record.message,
    workspace: record.workspaceId,
    workspaceId: record.workspaceId,
    postId: record.postId,
  };
  const rest = Object.entries(line).filter(([key, value]) => !(Object.hasOwn(shown, key) && value === shown[key]));
  return blockText(JSON.stringify(Object.fromEntries(rest)));
}

export function durationSeconds(startedAt: string, finishedAt: string): number {
  return (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000;
}

export const KIND_LABELS: Record<RecordKind, MessageKey> = {
  log: "records.kindLog",
  "provider-call": "records.kindProviderCall",
};

export const LEVEL_LABELS: Record<RecordLevel, MessageKey> = {
  error: "records.levelError",
  warn: "records.levelWarn",
  info: "records.levelInfo",
  debug: "records.levelDebug",
};

export const LEVEL_FILTER_LABELS: Record<RecordLevelFilter, MessageKey> = {
  attention: "records.levelAttention",
  ...LEVEL_LABELS,
};

// A stored purpose is the app's own name for the AI feature that made the call;
// each is shown by the name its tab carries.
const PURPOSE_LABELS: Readonly<Record<string, MessageKey>> = {
  analysis: "tabs.analysis",
  metadata: "tabs.metadata",
  imaging: "tabs.imaging",
};

export function purposeLabel(purpose: string): MessageKey | null {
  return Object.hasOwn(PURPOSE_LABELS, purpose) ? PURPOSE_LABELS[purpose]! : null;
}

// The page after the last record shown.
export function cursorAfter(records: readonly RecordSummary[]): RecordCursor | null {
  const last = records.at(-1);
  return last === undefined ? null : { time: last.time, kind: last.kind, id: last.id };
}

// The order the list shows records in, newest first; the database pages them
// the same way.
function newestFirst(a: RecordSummary, b: RecordSummary): number {
  if (a.time !== b.time) return a.time < b.time ? 1 : -1;
  if (a.kind !== b.kind) return a.kind < b.kind ? 1 : -1;
  return b.id - a.id;
}

// The newest page read again, joined with the rows already shown: a row in
// both takes the page's copy, and the rows shown beyond the page stay, so the
// pages already read are kept and a page read out of order loses nothing.
export function mergeNewestPage(
  shown: readonly RecordSummary[],
  shownMore: boolean,
  page: RecordsPage,
): { records: RecordSummary[]; more: boolean } {
  const byKey = new Map(shown.map((record) => [recordKey(record), record]));
  for (const record of page.records) byKey.set(recordKey(record), record);
  const records = [...byKey.values()].sort(newestFirst);
  const last = page.records.at(-1);
  const beyond = last !== undefined && shown.some((record) => newestFirst(record, last) > 0);
  return { records, more: beyond ? shownMore : page.more };
}
