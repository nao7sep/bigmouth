/**
 * What the records window asks of records.sqlite3 (recordsStore.ts owns the
 * schema): a filtered page of summaries, newest first and keyset-paged, the
 * launches that have records, and one record whole.
 *
 * Runs in the records reader's worker, which Node starts from this source in
 * tests: its only runtime import is `node:sqlite`.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { RecordDetail, RecordKind, RecordsPage, RecordsQuery, RecordSummary } from "@shared/records";

export const RECORDS_PAGE_SIZE = 100;

export type RecordsRead =
  | { op: "page"; query: RecordsQuery }
  | { op: "sessions" }
  | { op: "detail"; kind: RecordKind; id: number };

export interface RecordsReadResults {
  page: RecordsPage;
  sessions: string[];
  detail: RecordDetail | null;
}

// A provider call has no level of its own; a failed one reads as an error.
const CALL_LEVEL = "CASE WHEN error IS NULL THEN 'info' ELSE 'error' END";
// The model as the request carries it: in the body that was sent, or in the
// parameters when the sent request could not be captured.
const CALL_MODEL =
  "CASE WHEN json_valid(request) THEN COALESCE(json_extract(request, '$.body.model'), json_extract(request, '$.model')) END";
const LOG_SEARCHED = ["message", "workspace_id", "post_id", "event"];
const CALL_SEARCHED = ["provider", "purpose", "workspace_id", "post_id", "request", "response", "error"];

export function readRecords(db: DatabaseSync, read: RecordsRead): RecordsReadResults[RecordsRead["op"]] {
  if (read.op === "page") return readPage(db, read.query);
  if (read.op === "sessions") return readSessions(db);
  return readDetail(db, read.kind, read.id);
}

function likePattern(search: string): string | null {
  const trimmed = search.trim();
  return trimmed === "" ? null : `%${trimmed.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

export function readPage(db: DatabaseSync, query: RecordsQuery): RecordsPage {
  const pattern = likePattern(query.search);
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  const table = (select: string, from: string, level: string, searched: string[]): void => {
    const where = ["1 = 1"];
    if (query.session !== null) {
      where.push("session = ?");
      params.push(query.session);
    }
    if (query.level === "attention") {
      where.push(`${level} IN ('warn', 'error')`);
    } else if (query.level !== null) {
      where.push(`${level} = ?`);
      params.push(query.level);
    }
    if (pattern !== null) {
      where.push(`(${searched.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      params.push(...searched.map(() => pattern));
    }
    parts.push(`${select} FROM ${from} WHERE ${where.join(" AND ")}`);
  };
  if (query.kind !== "provider-call") {
    table(
      "SELECT 'log' AS kind, id, session, time, level, message AS title, NULL AS text, 0 AS stopped",
      "log_records", "level", LOG_SEARCHED,
    );
  }
  if (query.kind !== "log") {
    table(
      `SELECT 'provider-call' AS kind, id, session, started_at AS time, ${CALL_LEVEL} AS level,
        provider || ' ' || purpose AS title, ${CALL_MODEL} AS text, stopped`,
      "provider_calls", CALL_LEVEL, CALL_SEARCHED,
    );
  }
  let after = "";
  if (query.after !== null) {
    const { time, kind, id } = query.after;
    after = "WHERE time < ? OR (time = ? AND (kind < ? OR (kind = ? AND id < ?)))";
    params.push(time, time, kind, kind, id);
  }
  params.push(RECORDS_PAGE_SIZE + 1);
  const rows = db.prepare(
    `SELECT * FROM (${parts.join(" UNION ALL ")}) ${after} ORDER BY time DESC, kind DESC, id DESC LIMIT ?`,
  ).all(...params) as unknown as (Omit<RecordSummary, "stopped"> & { stopped: number })[];
  const records = rows.slice(0, RECORDS_PAGE_SIZE).map((row) => ({ ...row, stopped: row.stopped === 1 }));
  return { records, more: rows.length > RECORDS_PAGE_SIZE };
}

export function readSessions(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT session FROM log_records UNION SELECT session FROM provider_calls ORDER BY session DESC",
  ).all() as { session: string }[];
  return rows.map((row) => row.session);
}

export function readDetail(db: DatabaseSync, kind: RecordKind, id: number): RecordDetail | null {
  if (kind === "log") {
    const row = db.prepare(
      `SELECT 'log' AS kind, id, session, time, level, message, workspace_id AS workspaceId, post_id AS postId, event
        FROM log_records WHERE id = ?`,
    ).get(id);
    return (row as unknown as RecordDetail | undefined) ?? null;
  }
  const row = db.prepare(
    `SELECT 'provider-call' AS kind, id, session, workspace_id AS workspaceId, post_id AS postId, purpose, provider,
      started_at AS startedAt, finished_at AS finishedAt, request, response, error, stopped
      FROM provider_calls WHERE id = ?`,
  ).get(id) as (Omit<RecordDetail, "stopped"> & { stopped: number }) | undefined;
  return row ? ({ ...row, stopped: row.stopped === 1 } as RecordDetail) : null;
}
