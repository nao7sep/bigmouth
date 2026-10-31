// store-recovery-conventions, What a refused file does: the files the launch
// opens are checked before any is written; a newer one, or an unreadable one
// worth keeping, stops the launch, named with the others.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkLaunchFiles, refusedFilesError } from "@main/core/services/launchCheck.js";
import { initStorageRoot, getAppRoot } from "@main/core/services/storagePaths.js";
import { closeLogger } from "@main/core/services/logger.js";
import { getAppSettingsLoad } from "@main/core/services/appSettingsStore.js";
import { storageTasks } from "@main/storageTasks.js";
import { carriedMessage } from "@shared/i18n/carriedMessage";
import { createTranslator, message } from "@shared/i18n/translate";
import { fileHeader, newerHeader } from "../fileHeader.js";

const SAVED_DATA_DIR = process.env.BIGMOUTH_DATA_DIR;
let root: string;
const file = (name: string) => path.join(root, name);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-launch-"));
  process.env.BIGMOUTH_DATA_DIR = root;
  initStorageRoot();
});

afterEach(() => {
  closeLogger();
  if (SAVED_DATA_DIR === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_DATA_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

// Every file under the root with its bytes, to show the launch wrote nothing.
function snapshot(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(path.relative(root, full), fs.readFileSync(full).toString("base64"));
    }
  };
  walk(root);
  return files;
}

function sqlite(name: string, sql: string): void {
  const db = new DatabaseSync(file(name));
  db.exec(sql);
  db.close();
}

const header = (kind: string) => `CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO file_header VALUES ('format.owner', 'bigmouth'), ('format.kind', '${kind}');`;

describe("the launch check", () => {
  it("passes a first launch and a launch over usable files", () => {
    expect(checkLaunchFiles()).toEqual({ refused: [], backupsOff: null });
    fs.writeFileSync(file("workspaces.json"), JSON.stringify({ ...fileHeader("workspaces"), workspaces: [] }));
    fs.writeFileSync(file("config.json"), JSON.stringify({ ...fileHeader("appConfig"), theme: "dark" }));
    fs.writeFileSync(file("api-keys.json"), JSON.stringify({ ...fileHeader("apiKeys"), workspaces: {} }));
    fs.writeFileSync(file("state.json"), JSON.stringify({ ...fileHeader("state"), zoomLevel: 1 }));
    expect(checkLaunchFiles()).toEqual({ refused: [], backupsOff: null });
  });

  it.each([
    ["workspaces.json", "workspaces"],
    ["config.json", "appConfig"],
    ["api-keys.json", "apiKeys"],
    ["state.json", "state"],
  ] as const)("stops on a %s a newer version wrote", (name, format) => {
    fs.writeFileSync(file(name), JSON.stringify({ ...newerHeader(format, 2) }));
    expect(checkLaunchFiles().refused).toEqual([{ path: file(name), newer: true }]);
  });

  it.each(["records.sqlite3", "backups.sqlite3"])("stops on a %s a newer version wrote", (name) => {
    sqlite(name, "CREATE TABLE future (id INTEGER); PRAGMA user_version = 2");
    expect(checkLaunchFiles().refused).toEqual([{ path: file(name), newer: true }]);
  });

  it.each([
    ["workspaces.json", "{ not json"],
    ["workspaces.json", JSON.stringify({ workspaces: [] })],
    ["workspaces.json", JSON.stringify({ ...fileHeader("workspaces"), workspaces: {} })],
    ["config.json", "{ not json"],
    ["config.json", JSON.stringify({ ...fileHeader("workspaceConfig") })],
    ["api-keys.json", "{ not json"],
    ["api-keys.json", JSON.stringify({ ...fileHeader("apiKeys"), workspaces: [] })],
  ])("stops on an unreadable %s (%s)", (name, body) => {
    fs.writeFileSync(file(name), body);
    expect(checkLaunchFiles().refused).toEqual([{ path: file(name), newer: false }]);
  });

  it("lets unreadable view state fall back, and switches an unreadable backups database off", () => {
    fs.writeFileSync(file("state.json"), "{ not json");
    sqlite("records.sqlite3", "CREATE TABLE earlier (id INTEGER)");
    fs.writeFileSync(file("backups.sqlite3"), "not a database ".repeat(20));
    expect(checkLaunchFiles()).toEqual({ refused: [], backupsOff: file("backups.sqlite3") });
  });

  it("reads a usable database's header without changing it", () => {
    sqlite("backups.sqlite3", header("backups") + "PRAGMA user_version = 1;");
    const before = snapshot();
    expect(checkLaunchFiles()).toEqual({ refused: [], backupsOff: null });
    expect(snapshot()).toEqual(before);
  });

  it("names every refused file in one message saying what to do", () => {
    const error = refusedFilesError([
      { path: "/r/config.json", newer: true },
      { path: "/r/api-keys.json", newer: false },
    ]);
    const t = createTranslator("en");
    expect(t.text(carriedMessage(error)!)).toBe(
      "/r/config.json was saved by a newer version of BigMouth.\n/r/api-keys.json could not be read.\n\n" +
      "BigMouth left these files unchanged. Open them with the newer version of BigMouth, or repair, restore or move them away so BigMouth can start without them.",
    );
  });
});

describe("starting storage", () => {
  it("stops before writing anything when files are refused, naming each", () => {
    fs.writeFileSync(file("config.json"), JSON.stringify({ ...newerHeader("appConfig", 2), theme: "dark" }));
    fs.writeFileSync(file("api-keys.json"), "{ not json");
    sqlite("records.sqlite3", "CREATE TABLE future (id INTEGER); PRAGMA user_version = 2");
    const before = snapshot();
    let thrown: unknown;
    try { storageTasks.initialize(); } catch (error) { thrown = error; }
    expect(carriedMessage(thrown)).toEqual(message("startup.refused", {
      files: message("startup.lines", {
        first: message("startup.refusedNewer", { path: file("config.json") }),
        rest: message("startup.lines", {
          first: message("startup.refusedUnreadable", { path: file("api-keys.json") }),
          rest: message("startup.refusedNewer", { path: file("records.sqlite3") }),
        }),
      }),
    }));
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(file("workspaces.json"))).toBe(false);
  });

  it("starts over unusable records and backups databases, leaves them as they are, and says both are off", () => {
    sqlite("records.sqlite3", "CREATE TABLE earlier (id INTEGER)");
    fs.writeFileSync(file("backups.sqlite3"), "not a database ".repeat(20));
    const records = fs.readFileSync(file("records.sqlite3"));
    const backups = fs.readFileSync(file("backups.sqlite3"));
    storageTasks.initialize();
    expect(getAppSettingsLoad().notices).toEqual([
      message("startup.recordsOff", { path: file("records.sqlite3") }),
      message("startup.backupsOff", { path: file("backups.sqlite3") }),
    ]);
    closeLogger();
    expect(fs.readFileSync(file("records.sqlite3")).equals(records)).toBe(true);
    expect(fs.readFileSync(file("backups.sqlite3")).equals(backups)).toBe(true);
    expect(fs.readdirSync(getAppRoot()).filter((name) => name.endsWith(".invalid"))).toEqual([]);
  });

  it("starts with no notices when every store opens", () => {
    storageTasks.initialize();
    expect(getAppSettingsLoad().notices).toEqual([]);
  });
});
