/**
 * The app's two app-authored message surfaces, named and greppable.
 *
 * The modal-dialog conventions exempt native PICKERS from the naming rule but
 * say the exemption does not extend to message, alert or confirm boxes: those
 * are app-authored surfaces and must be routed through a named host rather than
 * built inline in feature code. Both of these were `dialog.showMessageBoxSync` /
 * `dialog.showErrorBox` calls sitting in the middle of `index.ts`'s lifecycle
 * handlers, where a grep for "Modal" or "Dialog" found neither.
 */

import { message } from "@shared/i18n/translate";
import { carriedMessage } from "@shared/i18n/carriedMessage";
import { mainTranslator } from "./i18n.js";
import { showPlainMessageDialog } from "./plain-message-dialog.js";

/** What the user chose when told their unsaved edits could not be written. */
export type UnsavedChangesChoice = "cancel" | "retry" | "proceed";

/** What quitting, or closing the window, now would lose. */
export interface UnsavedAtQuit {
  /** Buffered edits the store could not write. */
  writeFailures: boolean;
  /** A metadata field shows a value the store refused, so it was never buffered. */
  refusedMetadata: boolean;
}

/**
 * Asks whether to quit, or on macOS to close the main window, with edits that
 * could not be saved. The question comes while the edits are still on screen:
 * on macOS the app outlives its window, so leaving the question to a later quit
 * would ask about posts no longer in view.
 *
 * Edits that could not be written offer Retry, the default; a refused value
 * alone does not, because writing again cannot change it. Cancel is the Escape
 * path, because it loses nothing.
 */
export async function confirmUnsavedChanges(unsaved: UnsavedAtQuit, action: "quit" | "close"): Promise<UnsavedChangesChoice> {
  const { t } = mainTranslator();
  const refused = message("dialog.refusedMetadata.explanation");
  const proceed = t(action === "quit" ? "dialog.quitAnyway" : "dialog.closeAnyway");
  if (unsaved.writeFailures) {
    const detail = action === "quit"
      ? unsaved.refusedMetadata
        ? t("dialog.unsavedChanges.detailWithMetadata", { refused })
        : t("dialog.unsavedChanges.detail")
      : unsaved.refusedMetadata
        ? t("dialog.unsavedChanges.closeDetailWithMetadata", { refused })
        : t("dialog.unsavedChanges.closeDetail");
    const choice = await showPlainMessageDialog({
      title: t("dialog.unsavedChanges.title"),
      message: t("dialog.unsavedChanges.message"),
      detail,
      buttons: [t("common.cancel"), t("common.retry"), proceed],
      defaultId: 1,
      cancelId: 0,
      destructiveId: 2,
    });
    return choice === 1 ? "retry" : choice === 2 ? "proceed" : "cancel";
  }
  const choice = await showPlainMessageDialog({
    title: t("dialog.unsavedMetadata.title"),
    message: t("dialog.unsavedMetadata.message"),
    detail: t(action === "quit" ? "dialog.unsavedMetadata.quitDetail" : "dialog.unsavedMetadata.closeDetail", { refused }),
    buttons: [t("common.cancel"), proceed],
    defaultId: 0,
    cancelId: 0,
    destructiveId: 1,
  });
  return choice === 1 ? "proceed" : "cancel";
}

/**
 * The fatal-halt alert: startup failed, so there is no window to show anything
 * in. It names what went wrong and states that nothing was changed, because a
 * halt is only actionable if the user knows where they stand. A failure that
 * carries its own message, such as a store a newer version wrote, is told in
 * those words.
 */
export async function showStartupFailure(err: unknown): Promise<void> {
  const { t, text } = mainTranslator();
  const carried = carriedMessage(err);
  await showPlainMessageDialog({
    title: t("dialog.startupFailure.title"),
    message: t("dialog.startupFailure.message"),
    detail: carried ? text(carried) : t("dialog.startupFailure.detail"),
  });
}
