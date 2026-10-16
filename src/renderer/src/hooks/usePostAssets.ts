import { useSyncExternalStore } from "react";
import type { AssetMeta } from "@shared/types";

/**
 * The latest asset listing of each post, as the Assets tab last loaded it.
 *
 * The Assets tab lists a post's assets whenever it opens and after each change,
 * and the Preview needs the same listing to show each image through its display
 * image, so the tab publishes what it loaded here rather than the Preview
 * listing it again. `null` means the listing failed: the Preview then shows the
 * originals, as before renditions existed. A post absent from the store has not
 * been listed yet.
 */
const listings = new Map<string, readonly AssetMeta[] | null>();
const listeners = new Set<() => void>();

function key(workspaceId: string, postId: string): string {
  return `${workspaceId}\u0000${postId}`;
}

export function publishPostAssets(workspaceId: string, postId: string, assets: readonly AssetMeta[] | null): void {
  listings.set(key(workspaceId, postId), assets);
  for (const listener of listeners) listener();
}

/** Drops a post's listing while it is listed again, so nothing shows a listing older than the files. */
export function clearPostAssets(workspaceId: string, postId: string): void {
  if (listings.delete(key(workspaceId, postId))) for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The post's published listing: its assets, `null` when listing failed, `undefined` before the first. */
export function usePostAssets(workspaceId: string, postId: string): readonly AssetMeta[] | null | undefined {
  const id = key(workspaceId, postId);
  return useSyncExternalStore(subscribe, () => listings.get(id));
}
