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

/**
 * Asks whether to quit with edits that could not be saved.
 *
 * Cancel is both the default and the Escape path, because it is the choice that
 * loses nothing.
 */
export async function confirmQuitWithUnsavedChanges(): Promise<UnsavedChangesChoice> {
  const choice = await showPlainMessageDialog({
    title: "Unsaved changes",
    message: "Some edits could not be saved.",
    detail:
      "BigMouth could not write your latest changes to disk. " +
      "Quit anyway and lose them, or cancel and copy your text somewhere safe? " +
      "The editor shows why each post could not be saved.",
    buttons: ["Cancel", "Quit Anyway"],
    defaultId: 0,
    cancelId: 0,
    destructiveId: 1,
  });
  return choice === 0 ? "cancel" : "quit-anyway";
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
