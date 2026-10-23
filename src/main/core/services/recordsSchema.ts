import type { DatabaseSync } from "node:sqlite";

export const RECORDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS log_records (
  id           INTEGER PRIMARY KEY,
  session      TEXT NOT NULL,
  time         TEXT NOT NULL,
  level        TEXT NOT NULL,
  message      TEXT NOT NULL,
  workspace_id TEXT,
  post_id      TEXT,
  event        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_records_time ON log_records (time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_log_records_session_time ON log_records (session, time DESC, id DESC);
CREATE TABLE IF NOT EXISTS provider_calls (
  id           INTEGER PRIMARY KEY,
  session      TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  post_id      TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  operation_id TEXT,
  provider     TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  elapsed_ms   REAL,
  request      TEXT NOT NULL,
  response     TEXT,
  error        TEXT,
  stopped      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_provider_calls_time ON provider_calls (started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_provider_calls_session_time ON provider_calls (session, started_at DESC, id DESC);
`;

export function validateRecordsSchema(db: DatabaseSync): void {
  db.prepare("SELECT id, session, time, level, message, workspace_id, post_id, event FROM log_records LIMIT 0").all();
  db.prepare("SELECT id, session, workspace_id, post_id, purpose, operation_id, provider, started_at, finished_at, elapsed_ms, request, response, error, stopped FROM provider_calls LIMIT 0").all();
}
