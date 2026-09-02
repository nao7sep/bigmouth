import { ipcMain, shell } from "electron";

import { CHANNELS } from "@shared/ipc";
import { info } from "../core/services/logger.js";

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

/** Keeps OS-handler rejection observable to the initiating renderer. */
export async function openExternalUrl(rawUrl: string): Promise<void> {
  if (!isAllowedExternalUrl(rawUrl)) throw new Error("External URL is not allowed");
  await shell.openExternal(rawUrl);
  info("external URL opened", { protocol: new URL(rawUrl).protocol });
}

export function registerExternalHandlers(): void {
  ipcMain.handle(CHANNELS.openExternal, (_event, rawUrl: string) => openExternalUrl(rawUrl));
}
