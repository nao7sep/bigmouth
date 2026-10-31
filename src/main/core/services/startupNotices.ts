/**
 * What the user is told once the window opens about stores this launch left
 * off: a records or backups database BigMouth cannot use stays as it is and the
 * app keeps running without it (store-recovery-conventions).
 */

import type { Message } from "@shared/i18n/translate";

let notices: Message[] = [];

export function setStartupNotices(next: Message[]): void {
  notices = [...next];
}

export function startupNotices(): Message[] {
  return [...notices];
}
