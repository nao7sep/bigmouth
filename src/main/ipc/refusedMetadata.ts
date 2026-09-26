import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";

/**
 * The window reporting refused metadata: the slice of Electron's WebContents
 * this registry uses, so it can be driven without Electron in tests.
 */
export interface RefusalOwner {
  id: number;
  once(event: "destroyed", listener: () => void): unknown;
  on(event: "render-process-gone", listener: () => void): unknown;
}

// Posts whose Metadata tab shows a value the store refused (an invalid slug, a
// slug another post uses), keyed by window. The store never buffered that
// value, so it lives only on screen; quitting or closing the window must ask
// before it goes. Only the renderer knows what its fields show, so it reports
// each change here.
const byOwner = new Map<number, Set<string>>();

export function setMetadataRefusal(owner: RefusalOwner, postId: string, refused: boolean): void {
  let posts = byOwner.get(owner.id);
  if (!posts) {
    if (!refused) return;
    posts = new Set();
    byOwner.set(owner.id, posts);
    const ownerId = owner.id;
    owner.once("destroyed", () => byOwner.delete(ownerId));
    // A crashed renderer took the value with it; nothing is left to protect.
    owner.on("render-process-gone", () => byOwner.get(ownerId)?.clear());
  }
  if (refused) posts.add(postId);
  else posts.delete(postId);
}

/** Whether this window shows a refused metadata value. */
export function holdsRefusedMetadata(ownerId: number): boolean {
  return (byOwner.get(ownerId)?.size ?? 0) > 0;
}

/** Whether any window shows a refused metadata value. */
export function anyRefusedMetadata(): boolean {
  for (const posts of byOwner.values()) if (posts.size > 0) return true;
  return false;
}

/** The user chose to close this window anyway: its refusals no longer count. */
export function forgetRefusedMetadata(ownerId: number): void {
  byOwner.get(ownerId)?.clear();
}

export function registerRefusedMetadataHandlers(): void {
  ipcMain.on(CHANNELS.reportMetadataRefusal, (event, postId: unknown, refused: unknown) => {
    if (typeof postId !== "string" || typeof refused !== "boolean") return;
    setMetadataRefusal(event.sender, postId, refused);
  });
}
