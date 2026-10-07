import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import {
  RECORD_KINDS,
  RECORD_LEVEL_FILTERS,
  type RecordKind,
  type RecordLevelFilter,
  type RecordSources,
  type RecordsQuery,
} from "@shared/records";
import { error as logError, serializeError } from "../core/services/logger.js";
import { readRecords } from "../core/services/recordsReader.js";
import { currentRecordsSession, listWorkspaces } from "../storageAccess.js";
import { openRecordsWindow } from "../records-window.js";

function assertRecordKind(value: unknown): asserts value is RecordKind {
  if (!RECORD_KINDS.includes(value as RecordKind)) {
    throw new Error("Invalid IPC parameter: kind must be a record kind.");
  }
}

function assertRecordsQuery(value: unknown): asserts value is RecordsQuery {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid IPC parameter: query must be an object.");
  }
  const query = value as Record<string, unknown>;
  if (query.session !== null && typeof query.session !== "string") {
    throw new Error("Invalid IPC parameter: query.session must be a string or null.");
  }
  if (query.kind !== null) assertRecordKind(query.kind);
  if (query.level !== null && !RECORD_LEVEL_FILTERS.includes(query.level as RecordLevelFilter)) {
    throw new Error("Invalid IPC parameter: query.level must be a record level filter or null.");
  }
  if (typeof query.search !== "string") {
    throw new Error("Invalid IPC parameter: query.search must be a string.");
  }
  if (query.after !== null) {
    const after = query.after as Record<string, unknown> | undefined;
    if (typeof after !== "object" || typeof after.time !== "string" || !Number.isInteger(after.id)) {
      throw new Error("Invalid IPC parameter: query.after must be a record cursor or null.");
    }
    assertRecordKind(after.kind);
  }
}

// A successful read logs nothing: each record stored signals the window, so a
// logged read would start the next one.
async function logged<T>(channel: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    logError("records read failed", { channel, error: serializeError(err) });
    throw err;
  }
}

export function registerRecordsHandlers(): void {
  ipcMain.handle(CHANNELS.openRecordsWindow, async () => {
    try {
      await openRecordsWindow();
    } catch (err) {
      logError("records window open failed", { error: serializeError(err) });
      throw err;
    }
  });

  ipcMain.handle(CHANNELS.readRecordsPage, async (_event, query: unknown) =>
    logged(CHANNELS.readRecordsPage, async () => {
      assertRecordsQuery(query);
      return readRecords({ op: "page", query });
    }),
  );

  ipcMain.handle(CHANNELS.readRecordDetail, async (_event, kind: unknown, id: unknown) =>
    logged(CHANNELS.readRecordDetail, async () => {
      assertRecordKind(kind);
      if (!Number.isInteger(id)) throw new Error("Invalid IPC parameter: id must be an integer.");
      return readRecords({ op: "detail", kind, id: id as number });
    }),
  );

  ipcMain.handle(CHANNELS.readRecordSources, async () =>
    logged(CHANNELS.readRecordSources, async (): Promise<RecordSources> => ({
      currentSession: await currentRecordsSession(),
      sessions: await readRecords({ op: "sessions" }),
      workspaces: (await listWorkspaces()).map(({ id, name }) => ({ id, name })),
    })),
  );
}
