import type { MessageKey } from "@shared/i18n/catalogues";
import type {
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

// Stored JSON, indented for reading; text that is not JSON is shown as it is.
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
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
