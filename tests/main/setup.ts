// Shared setup and teardown for every main-process test.
//
// The data-backup store is a module-level singleton keyed to the storage root resolved at first open
// (getAppRoot() → BIGMOUTH_DATA_DIR/~/.bigmouth). Many tests relocate that root to a fresh throwaway
// directory per test; without resetting the singleton, one test's open would leak its DB handle (pointing
// at an already-deleted root) into the next. Closing it after every test forces the next record() to
// re-open against the current throwaway root, so the store follows the relocation exactly as it would
// across real launches. Closing an unopened store is a harmless no-op.
//
// The home directory is a throwaway too. A workspace created without a location goes to
// <home>/Documents/BigMouth, which BIGMOUTH_DATA_DIR does not move, so a test must never reach the
// developer's real Documents. os.homedir() reads HOME on macOS and Linux and USERPROFILE on Windows;
// both point at a fresh directory for each test, and anything a test leaves there is removed with it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { closeBackupStore } from "@main/core/services/backupStore.js";

const SAVED_HOME = process.env.HOME;
const SAVED_USERPROFILE = process.env.USERPROFILE;
let testHome: string | null = null;

function restore(name: "HOME" | "USERPROFILE", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-test-home-"));
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
});

afterEach(() => {
  closeBackupStore();
  restore("HOME", SAVED_HOME);
  restore("USERPROFILE", SAVED_USERPROFILE);
  if (testHome !== null) fs.rmSync(testHome, { recursive: true, force: true });
  testHome = null;
});
