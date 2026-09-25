import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";

/**
 * The window a paid AI request belongs to: the slice of Electron's WebContents
 * this registry uses, so it can be driven without Electron in tests.
 */
export interface AiRequestOwner {
  id: number;
  once(event: "destroyed", listener: () => void): unknown;
  on(event: "render-process-gone", listener: () => void): unknown;
}

// Every in-flight paid AI call (analysis stream, metadata, imaging), keyed by the
// window that asked for it and then by that window's request id. Keying by the
// window as well as the id is what keeps two renderer instances apart: ids are
// generated in the renderer, so a reopened window could otherwise reuse a live id
// and one window's abort (or completion) would reach the other's call.
const byOwner = new Map<number, Map<string, () => void>>();

function abortAll(ownerId: number): void {
  const requests = byOwner.get(ownerId);
  if (!requests) return;
  const aborts = [...requests.values()];
  requests.clear();
  for (const abort of aborts) abort();
}

/**
 * Registers an in-flight request so the renderer's abort, and the window's own
 * teardown, can reach the paid call. Returns the release to call when the call
 * settles.
 *
 * A request whose window closes or whose renderer dies is aborted with it: the
 * app stays alive on macOS after its window closes, and nothing else would stop
 * a stream from billing to `max_tokens` for a window that can never show it.
 */
export function trackAiRequest(owner: AiRequestOwner, requestId: string, abort: () => void): () => void {
  let requests = byOwner.get(owner.id);
  if (!requests) {
    requests = new Map();
    byOwner.set(owner.id, requests);
    const ownerId = owner.id;
    owner.once("destroyed", () => {
      abortAll(ownerId);
      byOwner.delete(ownerId);
    });
    owner.on("render-process-gone", () => abortAll(ownerId));
  }
  const tracked = requests;
  tracked.set(requestId, abort);
  return () => {
    if (tracked.get(requestId) === abort) tracked.delete(requestId);
  };
}

/**
 * Registers the one abort channel every AI request shares.
 *
 * The renderer may send an abort right after it starts a request. That is safe
 * for the invoke-based calls because Electron delivers one renderer's messages
 * in order and calls an `ipcMain.handle` handler synchronously on arrival, and
 * every handler here registers its request before its first `await`. An abort
 * for an id that is not registered has already finished, and is ignored.
 */
export function registerAiRequestHandlers(): void {
  ipcMain.on(CHANNELS.aiRequestAbort, (event, requestId: string) => {
    if (typeof requestId !== "string") return;
    const requests = byOwner.get(event.sender.id);
    const abort = requests?.get(requestId);
    if (!abort) return;
    requests!.delete(requestId);
    abort();
  });
}
