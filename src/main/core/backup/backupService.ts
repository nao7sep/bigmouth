/**
 * The startup edge for the data backup: runs one pass without blocking startup and logs the outcome. This
 * is the only place the feature logs; the pass itself ({@link runBackup}) does not. Best-effort — it never
 * blocks the window, shows an error, or crashes the app.
 *
 * Electron's main process is single-threaded, so "background" here means fire-and-forget async on the event
 * loop after the window is created: the renderer is a separate process, so this never blocks the UI's paint.
 */
import { runBackup } from "./backupEngine.js";
import { utcNow } from "../shared/timestamps.js";
import { debug, info, warn, error as logError, serializeError } from "../services/logger.js";
import type { BackupReport } from "./backupTypes.js";

/** Runs one backup pass in the background and logs its outcome. Fire-and-forget; never throws. */
export function runBackupInBackground(): void {
  void runOnce();
}

async function runOnce(): Promise<void> {
  try {
    logReport(await runBackup(utcNow()));
  } catch (err) {
    // The engine captures its own failures in the report; this is the final backstop so a bug here can
    // never surface to the user or take down the app.
    logError("backup: unexpected failure", { error: serializeError(err) });
  }
}

function logReport(report: BackupReport): void {
  for (const skip of report.skips) {
    warn("backup: skipped a file", { path: skip.path, reason: skip.reason });
  }

  if (report.indexWasReset) {
    warn("backup: index was unreadable and reset; this run is a full backup");
  }

  if (report.fatal !== undefined) {
    logError("backup: run failed", { error: serializeError(report.fatal) });
    return;
  }

  if (report.nothingChanged) {
    debug("backup: nothing changed, no archive written");
    return;
  }

  info("backup: archive written", { archive: report.archiveFileName, files: report.filesArchived });
}
