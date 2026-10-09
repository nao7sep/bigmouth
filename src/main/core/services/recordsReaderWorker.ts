// The records reader's thread: it holds its own read-only connection to
// records.sqlite3, so the window's reads never run on the main process
// (PLAYBOOK, Own the work in flight). The main process keeps writing through its
// own connection; WAL lets this one read beside it.

import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

import { readRecords, type RecordsRead } from "./recordsQueries.ts";
import { FORMAT_VERSIONS } from "../shared/formatVersions.ts";

export type RecordsReaderRequest = { id: number; read: RecordsRead };

export type RecordsReaderResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

if (parentPort === null) {
  throw new Error("The records reader requires a parent port.");
}

const port = parentPort;
const { databasePath } = workerData as { databasePath: string };
let db: DatabaseSync | null = null;

// A lock the writer holds is waited on for a bounded time, well inside the
// reader's own timeout. A database a newer build wrote is not read
// (store-recovery-conventions); one without its version is this build's format.
function open(): DatabaseSync {
  const opened = new DatabaseSync(databasePath, { readOnly: true });
  try {
    opened.exec("PRAGMA busy_timeout = 2000");
    const { user_version: version } = opened.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version > FORMAT_VERSIONS.records) {
      throw new Error(`${databasePath} is in format ${version}, which this build cannot read; it was left unchanged.`);
    }
  } catch (error: unknown) {
    opened.close();
    throw error;
  }
  return opened;
}

port.on("message", ({ id, read }: RecordsReaderRequest) => {
  let response: RecordsReaderResponse;
  try {
    db ??= open();
    response = { id, ok: true, value: readRecords(db, read) };
  } catch (error: unknown) {
    response = { id, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  port.postMessage(response);
});
