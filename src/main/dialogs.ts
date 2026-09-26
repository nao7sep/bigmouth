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

const REFUSED_METADATA_DETAIL =
  "A metadata field shows a value BigMouth refused, such as a slug another post uses, " +
  "so the post keeps its last accepted value. The field says why.";

/**
 * Asks whether to quit with edits that could not be saved.
 *
 * Cancel is both the default and the Escape path, because it is the choice that
 * loses nothing.
 */
export async function confirmQuitWithUnsavedChanges(unsaved: UnsavedAtQuit): Promise<UnsavedChangesChoice> {
  const choice = await showPlainMessageDialog(
    unsaved.writeFailures
      ? {
          title: "Unsaved changes",
          message: "Some edits could not be saved.",
          detail:
            "BigMouth could not write your latest changes to disk. " +
            (unsaved.refusedMetadata ? `${REFUSED_METADATA_DETAIL} ` : "") +
            "Quit anyway and lose them, or cancel and copy your text somewhere safe? " +
            "The editor shows why each post could not be saved.",
          buttons: ["Cancel", "Quit Anyway"],
          defaultId: 0,
          cancelId: 0,
          destructiveId: 1,
        }
      : {
          title: "Unsaved metadata",
          message: "A metadata value was not saved.",
          detail: `${REFUSED_METADATA_DETAIL} Quit anyway and lose it, or cancel and fix the field?`,
          buttons: ["Cancel", "Quit Anyway"],
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
  const choice = await showPlainMessageDialog({
    title: "Unsaved metadata",
    message: "A metadata value was not saved.",
    detail: `${REFUSED_METADATA_DETAIL} Close anyway and lose it, or cancel and fix the field?`,
    buttons: ["Cancel", "Close Anyway"],
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
  await showPlainMessageDialog({
    title: "BigMouth could not start",
    message: "BigMouth could not finish opening its settings and workspace.",
    detail: "No posts or workspace documents were changed. Check the session log, then start BigMouth again.",
  });
}
