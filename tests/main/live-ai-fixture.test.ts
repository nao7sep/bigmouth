import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createLiveWorkspace } from "../live/main/ipc/ai-fixture.js";
import { closeBackupStore } from "@main/core/services/backupStore.js";
import { initAppDir } from "@main/core/services/workspaceStore.js";
import { createPost } from "@main/core/services/postStore.js";

it("keeps the live handler workspace and posts inside the disposable fixture root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-live-isolation-"));
  const originalRoot = process.env.BIGMOUTH_DATA_DIR;
  process.env.BIGMOUTH_DATA_DIR = root;
  try {
    initAppDir();
    const workspace = createLiveWorkspace(root);
    const post = createPost(workspace.dataDirectory, "blogger", "en");
    expect(workspace.dataDirectory).toBe(path.join(root, "workspace"));
    expect(path.relative(root, post.filePath)).toBe(path.join("workspace", "posts", path.basename(post.filePath)));
    expect(fs.existsSync(post.filePath)).toBe(true);
  } finally {
    closeBackupStore();
    if (originalRoot === undefined) delete process.env.BIGMOUTH_DATA_DIR;
    else process.env.BIGMOUTH_DATA_DIR = originalRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
  expect(fs.existsSync(root)).toBe(false);
});
