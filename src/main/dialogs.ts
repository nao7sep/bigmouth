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
import { mainTranslator } from "./i18n.js";
import { showPlainMessageDialog } from "./plain-message-dialog.js";

/** What the user chose when told their unsaved edits could not be written. */
export type UnsavedChangesChoice = "cancel" | "quit-anyway";

/** What quitting now would lose. */
export interface UnsavedAtQuit {
  /** Buffered edits the store could not write. */
  writeFailures: boolean;
  /** A metadata field shows a value the store refused, so it was never buffered. */
  refusedMetadata: boolean;
}

/**
 * Asks whether to quit with edits that could not be saved.
 *
 * Cancel is both the default and the Escape path, because it is the choice that
 * loses nothing.
 */
export async function confirmQuitWithUnsavedChanges(unsaved: UnsavedAtQuit): Promise<UnsavedChangesChoice> {
  const { t } = mainTranslator();
  const refused = message("dialog.refusedMetadata.explanation");
  const choice = await showPlainMessageDialog(
    unsaved.writeFailures
      ? {
          title: t("dialog.unsavedChanges.title"),
          message: t("dialog.unsavedChanges.message"),
          detail: unsaved.refusedMetadata
            ? t("dialog.unsavedChanges.detailWithMetadata", { refused })
            : t("dialog.unsavedChanges.detail"),
          buttons: [t("common.cancel"), t("dialog.quitAnyway")],
          defaultId: 0,
          cancelId: 0,
          destructiveId: 1,
        }
      : {
          title: t("dialog.unsavedMetadata.title"),
          message: t("dialog.unsavedMetadata.message"),
          detail: t("dialog.unsavedMetadata.quitDetail", { refused }),
          buttons: [t("common.cancel"), t("dialog.quitAnyway")],
          defaultId: 0,
          cancelId: 0,
          destructiveId: 1,
        },
  );
  return choice === 0 ? "cancel" : "quit-anyway";
}

/** What the user chose when closing a window that shows a refused metadata value. */
export type RefusedMetadataCloseChoice = "cancel" | "close-anyway";

/** Asks whether to close a window whose Metadata tab shows a refused value. */
export async function confirmCloseWithRefusedMetadata(): Promise<RefusedMetadataCloseChoice> {
  const { t } = mainTranslator();
  const choice = await showPlainMessageDialog({
    title: t("dialog.unsavedMetadata.title"),
    message: t("dialog.unsavedMetadata.message"),
    detail: t("dialog.unsavedMetadata.closeDetail", { refused: message("dialog.refusedMetadata.explanation") }),
    buttons: [t("common.cancel"), t("dialog.closeAnyway")],
    defaultId: 0,
    cancelId: 0,
    destructiveId: 1,
  });
  return choice === 0 ? "cancel" : "close-anyway";
}

/**
 * The fatal-halt alert: startup failed, so there is no window to show anything
 * in. It names what went wrong and states that nothing was changed, because a
 * halt is only actionable if the user knows where they stand.
 */
export async function showStartupFailure(): Promise<void> {
  const { t } = mainTranslator();
  await showPlainMessageDialog({
    title: t("dialog.startupFailure.title"),
    message: t("dialog.startupFailure.message"),
    detail: t("dialog.startupFailure.detail"),
  });
}
