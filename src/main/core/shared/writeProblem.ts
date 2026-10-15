import type { WorkspaceWriteProblem } from "@shared/ipc";

// Codes that change what the user can do about a failed write into the
// workspace folder (error-handling-conventions): free space, or check the
// folder's permissions. Any other filesystem code means the write itself
// failed, as on a disconnected or failing drive.
const FULL = new Set(["ENOSPC", "EDQUOT", "EFBIG"]);
const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * What kind of problem a failed filesystem write met, read from its error code,
 * or null for an error that carries no filesystem code, which is not a write
 * problem the user can act on.
 */
export function workspaceWriteProblem(error: unknown): WorkspaceWriteProblem | null {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (typeof code !== "string" || !code.startsWith("E")) return null;
  if (FULL.has(code)) return "full";
  if (DENIED.has(code)) return "denied";
  return "failed";
}
