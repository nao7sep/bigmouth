// The records reader's thread: it holds its own read-only connection to
// records.sqlite3, so the window's reads never run on the main process
// (PLAYBOOK, Own the work in flight). The main process keeps writing through its
// own connection; WAL lets this one read beside it.

import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

import { readRecords, type RecordsRead } from "./recordsQueries.ts";
import { isNewerThanBuild } from "../shared/formatVersions.ts";

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
// reader's own timeout. A database a newer version of BigMouth wrote is not read
// (store-recovery-conventions).
function open(): DatabaseSync {
  const opened = new DatabaseSync(databasePath, { readOnly: true });
  try {
    opened.exec("PRAGMA busy_timeout = 2000");
    const { user_version: version } = opened.prepare("PRAGMA user_version").get() as { user_version: number };
    if (isNewerThanBuild("records", version)) {
      throw new Error(`${databasePath} was written by a newer version of BigMouth (format ${version}); it was left unchanged.`);
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
