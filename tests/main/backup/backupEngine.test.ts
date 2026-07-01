// End-to-end backup runs over a throwaway BIGMOUTH_HOME: a first run captures workspaces.json and each
// workspace's files at the mirror paths; an unchanged run writes nothing; an edit captures only what
// changed; a corrupt index resets to a full backup; a dead workspace link is skipped without failing the
// run. Secrets are excluded from backups (data-backup conventions), so the backups dir/archives/index
// carry no key material and get no mode hardening.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yauzl from "yauzl";

vi.mock("@main/core/services/logger.js", () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  serializeError: (err: unknown) => err,
}));

import {
  initAppDir,
  createWorkspace,
  getBackupsDir,
  getBackupIndexPath,
} from "@main/core/services/workspaceStore.js";
import { runBackup } from "@main/core/backup/backupEngine.js";

const SAVED_HOME = process.env.BIGMOUTH_HOME;
const RUN1 = new Date("2026-07-01T00:00:00Z");
const RUN2 = new Date("2026-07-01T01:00:00Z");

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-backup-"));
  process.env.BIGMOUTH_HOME = home;
  initAppDir();
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function archivePath(name: string): string {
  return path.join(getBackupsDir(), name);
}

function zipEntries(zipFile: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    yauzl.open(zipFile, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("no zip"));
      zip.on("entry", (entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on("end", () => resolve(names.sort()));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

describe("runBackup", () => {
  it("captures workspaces.json and each workspace's files at mirror paths", async () => {
    const ws = createWorkspace("W1");
    fs.writeFileSync(path.join(ws.dataDirectory, "posts", "p1.md"), "# hi");

    const report = await runBackup(RUN1);

    expect(report.fatal).toBeUndefined();
    expect(report.nothingChanged).toBe(false);
    expect(report.archiveFileName).toBe("backup-20260701-000000-utc.zip");

    const entries = await zipEntries(archivePath(report.archiveFileName!));
    expect(entries).toContain("workspaces.json");
    expect(entries).toContain(`workspaces/${ws.id}/config.json`);
    expect(entries).toContain(`workspaces/${ws.id}/posts/p1.md`);
  });

  it("writes nothing on a second run with no changes", async () => {
    const ws = createWorkspace("W1");
    fs.writeFileSync(path.join(ws.dataDirectory, "posts", "p1.md"), "# hi");

    await runBackup(RUN1);
    const report = await runBackup(RUN2);

    expect(report.nothingChanged).toBe(true);
    expect(fs.existsSync(archivePath("backup-20260701-010000-utc.zip"))).toBe(false);
  });

  it("captures only the changed file after an edit", async () => {
    const ws = createWorkspace("W1");
    const post = path.join(ws.dataDirectory, "posts", "p1.md");
    fs.writeFileSync(post, "# hi");
    await runBackup(RUN1);

    fs.writeFileSync(post, "# hi, now longer"); // size differs, caught regardless of mtime

    const report = await runBackup(RUN2);

    expect(report.filesArchived).toBe(1);
    const entries = await zipEntries(archivePath("backup-20260701-010000-utc.zip"));
    expect(entries).toEqual([`workspaces/${ws.id}/posts/p1.md`]);
  });

  it("excludes OS-noise and *.tmp litter inside a workspace dataDirectory", async () => {
    const ws = createWorkspace("W1");
    fs.writeFileSync(path.join(ws.dataDirectory, "posts", "p1.md"), "# hi");
    // Finder browsing / atomic writes drop these into the external dataDir; they must not be archived.
    fs.mkdirSync(path.join(ws.dataDirectory, "assets", "post123"), { recursive: true });
    fs.writeFileSync(path.join(ws.dataDirectory, "assets", "post123", ".DS_Store"), "junk");
    fs.writeFileSync(path.join(ws.dataDirectory, "posts", "p1.md.9876.tmp"), "half-written");

    const report = await runBackup(RUN1);

    const entries = await zipEntries(archivePath(report.archiveFileName!));
    expect(entries).toContain(`workspaces/${ws.id}/posts/p1.md`);
    expect(entries).not.toContain(`workspaces/${ws.id}/assets/post123/.DS_Store`);
    expect(entries).not.toContain(`workspaces/${ws.id}/posts/p1.md.9876.tmp`);
  });

  it("resets a corrupt index to a full backup", async () => {
    const ws = createWorkspace("W1");
    fs.writeFileSync(path.join(ws.dataDirectory, "posts", "p1.md"), "# hi");
    await runBackup(RUN1);

    fs.writeFileSync(getBackupIndexPath(), "{ not valid json");

    const report = await runBackup(RUN2);

    expect(report.indexWasReset).toBe(true);
    expect(report.filesArchived).toBe(3); // workspaces.json + config.json + p1.md
  });

  it("skips a dead workspace link and continues", async () => {
    const ws = createWorkspace("W1");
    fs.rmSync(ws.dataDirectory, { recursive: true, force: true });

    const report = await runBackup(RUN1);

    expect(report.nothingChanged).toBe(false); // workspaces.json is still captured
    expect(report.skips.some((skip) => skip.path === ws.dataDirectory)).toBe(true);
  });
});
