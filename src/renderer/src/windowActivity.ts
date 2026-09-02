/**
 * Applies main-process BrowserWindow activation to renderer chrome. The caller
 * supplies the bridge subscription so this state owner remains directly testable
 * without importing the renderer entrypoint.
 */
export function installWindowActivityState(
  subscribe: (listener: (active: boolean) => void) => () => void,
  root: Pick<Element, "toggleAttribute">,
): () => void {
  return subscribe((active) => {
    root.toggleAttribute("data-window-inactive", !active);
  });
}
