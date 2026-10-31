/**
 * The files BigMouth opens to start, checked before anything is written
 * (store-recovery-conventions, What a refused file does). Any of them a newer
 * build wrote, and the registry, app settings or key file when they cannot be
 * read, stop the launch together, each named. Unreadable view state falls back
 * on its own; an unreadable backups database is switched off with a notice, as
 * the records database is when the logger opens it.
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { carryingText } from "@shared/i18n/carriedMessage";
import { message, type Message } from "@shared/i18n/translate";
import type { StoreFormat } from "../shared/formatVersions.js";
import { readJsonStore } from "../shared/storeFormat.js";
import { checkSqliteHeader } from "../shared/sqliteHeader.js";
import { keyFileRefusal } from "./apiKeys.js";
import { getApiKeysPath, getAppConfigPath, getBackupsDbPath, getRecordsDbPath, getStateJsonPath } from "./storagePaths.js";
import { registryRefusal } from "./workspaceStore.js";

/** A file that stops the launch: a newer build wrote it, or it could not be read. */
export type RefusedFile = { path: string; newer: boolean };

export type LaunchCheck = {
  refused: RefusedFile[];
  /** The backups database, when it cannot be used: left as it is, backups off for the session. */
  backupsOff: string | null;
};

/** Checks every file the launch opens, after the storage root is resolved and before any is written. */
export function checkLaunchFiles(): LaunchCheck {
  const refused: RefusedFile[] = [];
  const add = (found: RefusedFile | null) => { if (found) refused.push(found); };
  add(registryRefusal());
  add(jsonRefusal("appConfig", getAppConfigPath(), true));
  add(keyFileRefusal(getApiKeysPath()));
  add(jsonRefusal("state", getStateJsonPath(), false));
  const records = sqliteCheck("records", getRecordsDbPath());
  if (records === "newer") refused.push({ path: getRecordsDbPath(), newer: true });
  const backups = sqliteCheck("backups", getBackupsDbPath());
  if (backups === "newer") refused.push({ path: getBackupsDbPath(), newer: true });
  return { refused, backupsOff: backups === "unreadable" ? getBackupsDbPath() : null };
}

// A newer file always stops the launch; an unreadable one only when it is worth keeping.
function jsonRefusal(format: StoreFormat, filePath: string, valuable: boolean): RefusedFile | null {
  const read = readJsonStore(format, filePath);
  if (read.kind === "newer") return { path: filePath, newer: true };
  if (valuable && (read.kind === "unreadable" || read.kind === "inaccessible")) return { path: filePath, newer: false };
  return null;
}

// Opened read-only, so nothing reaches a database the launch then refuses.
function sqliteCheck(format: StoreFormat, filePath: string): "absent" | "usable" | "newer" | "unreadable" {
  if (!fs.existsSync(filePath)) return "absent";
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    const check = checkSqliteHeader(db, format);
    if (check.kind === "newer") return "newer";
    return check.kind === "unreadable" ? "unreadable" : "usable";
  } catch {
    return "unreadable";
  } finally {
    try { db?.close(); } catch { /* Nothing was written. */ }
  }
}

/** The error that stops the launch, naming each refused file and what the user can do. */
export function refusedFilesError(refused: readonly RefusedFile[]): Error {
  const lines = refused.map((file) => message(file.newer ? "startup.refusedNewer" : "startup.refusedUnreadable", { path: file.path }));
  const files = lines.reduceRight<Message | null>((rest, line) => (rest ? message("startup.lines", { first: line, rest }) : line), null)!;
  return new Error(carryingText(message("startup.refused", { files })));
}
