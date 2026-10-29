/**
 * The files electron-vite builds for the main process to load at run time. The
 * build configuration names its outputs from these, and the code that starts a
 * worker or a window's preload loads them by the same names.
 */

/** Worker entries, built beside the main process's index.js as `<name>.js`. */
export const WORKER_ENTRIES = {
  storage: "storage-worker",
  backup: "backup-worker",
} as const;

/** The preload script, built into the preload output folder beside the main one. */
export const PRELOAD_FILE = "index.cjs";
