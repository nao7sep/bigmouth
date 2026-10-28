import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
import { closeBackupStore } from "@main/core/services/backupStore.js";

let nextFixture = 1;

export async function createPostStoreFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-poststore-"));
  try {
    // A fixture owns the same module lifetime a real storage worker gets at boot.
    // Its dependencies stay shared; resetting the entire module graph would lose
    // the backup recorder that the shared teardown owns.
    const source = new URL("../../../src/main/core/services/postStore.ts", import.meta.url).href;
    const store = await import(`${source}?fixture=${nextFixture++}`) as typeof import("@main/core/services/postStore.js");
    initializeWorkspaceData(dataDir);
    return {
      dataDir,
      store,
      dispose() {
        store.setContentSaveListener(null);
        store.flushAllPendingEdits();
        store.clearCache(dataDir);
        closeBackupStore();
        fs.rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    closeBackupStore();
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}
