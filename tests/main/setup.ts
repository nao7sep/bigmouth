// Shared teardown for every main-process test. The data-backup store is a module-level singleton keyed
// to the storage root resolved at first open (getAppRoot() → BIGMOUTH_HOME/~/.bigmouth). Many tests
// relocate that root to a fresh throwaway directory per test; without resetting the singleton, one test's
// open would leak its DB handle (pointing at an already-deleted root) into the next. Closing it after
// every test forces the next record() to re-open against the current throwaway root, so the store follows
// the relocation exactly as it would across real launches. Closing an unopened store is a harmless no-op.
import { afterEach } from "vitest";
import { closeBackupStore } from "@main/core/services/backupStore.js";

afterEach(() => {
  closeBackupStore();
});
