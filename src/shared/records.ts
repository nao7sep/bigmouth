// What the records window reads from records.sqlite3: a filtered page of
// summaries, newest first, and one record whole. JSON fields arrive as the text
// the database holds; the window decides how to show them.

export type RecordKind = "log" | "provider-call";

export type RecordLevel = "debug" | "info" | "warn" | "error";

export const RECORD_KINDS: readonly RecordKind[] = ["log", "provider-call"];

export const RECORD_LEVELS: readonly RecordLevel[] = ["error", "warn", "info", "debug"];

// What the level filter offers: a record's own level, or `attention`, every
// record at `warn` or `error`.
export type RecordLevelFilter = "attention" | RecordLevel;

export const RECORD_LEVEL_FILTERS: readonly RecordLevelFilter[] = ["attention", ...RECORD_LEVELS];

// Where the next page starts: the last summary of the page before it.
export interface RecordCursor {
  time: string;
  kind: RecordKind;
  id: number;
}

export interface RecordsQuery {
  // A launch, named by its session.
  session: string | null;
  kind: RecordKind | null;
  // A provider call reads as `error` when it failed and `info` otherwise.
  level: RecordLevelFilter | null;
  search: string;
  after: RecordCursor | null;
}

export interface RecordSummary {
  kind: RecordKind;
  id: number;
  session: string;
  time: string;
  level: RecordLevel;
  // A log line's message, or a provider call's provider and purpose.
  title: string;
  // A provider call's model; a log line has none.
  text: string | null;
  // A provider call the user stopped; it is neither a failure nor a result.
  stopped: boolean;
}

export interface RecordsPage {
  records: RecordSummary[];
  more: boolean;
}

export interface LogRecordDetail {
  kind: "log";
  id: number;
  session: string;
  time: string;
  level: RecordLevel;
  message: string;
  workspaceId: string | null;
  postId: string | null;
  // The whole line as it was emitted, as JSON text.
  event: string;
}

export interface ProviderCallRecordDetail {
  kind: "provider-call";
  id: number;
  session: string;
  workspaceId: string;
  postId: string;
  purpose: string;
  provider: string;
  startedAt: string;
  finishedAt: string;
  request: string;
  response: string | null;
  error: string | null;
  stopped: boolean;
}

export type RecordDetail = LogRecordDetail | ProviderCallRecordDetail;

// The values the filters and the detail pane name: every launch that has
// records, and the workspaces the app knows by name.
export interface RecordSources {
  currentSession: string | null;
  sessions: string[];
  workspaces: { id: string; name: string }[];
}
