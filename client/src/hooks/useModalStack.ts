import { useEffect, useId, useRef, useSyncExternalStore } from "react";

// A single source of truth for which app modals/dialogs are open, in stacking
// order. Every ModalShell registers a layer here on mount and removes it on
// unmount, so the topmost layer is always the last entry.
//
// This module owns the two pieces of behaviour that must be coordinated across
// every layer at once and therefore cannot live inside an individual shell:
//
//   - Escape routing. One document-level listener fires the topmost layer's
//     close handler only, so a confirm stacked over a settings modal unwinds
//     one layer per Escape instead of collapsing the whole stack.
//   - "Any modal open" — used to suppress the app's global keyboard shortcuts
//     while a modal/dialog has the foreground.
//
// Background scroll is already locked structurally by the global
// `html, body, #root { overflow: hidden }` reset, and modal backdrops are
// fixed-position with no scrollable ancestor, so no per-layer scroll lock is
// needed here.

interface ModalLayer {
  id: string;
  onRequestClose: () => void;
}

const layers: ModalLayer[] = [];
const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach((subscriber) => subscriber());
}

function handleDocumentKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  // While an IME composition is in progress, Escape cancels the candidate and
  // belongs to the IME, not the modal stack. (Mirrors isComposingKeyboardEvent;
  // no composition ref exists at the document level, so the native isComposing
  // flag plus the legacy keyCode === 229 fallback are the signal.)
  if (event.isComposing || event.keyCode === 229) return;
  const topmost = layers[layers.length - 1];
  if (!topmost) return;
  event.preventDefault();
  topmost.onRequestClose();
}

function pushLayer(layer: ModalLayer) {
  if (layers.length === 0) {
    document.addEventListener("keydown", handleDocumentKeyDown);
  }
  layers.push(layer);
  notify();
}

function removeLayer(id: string) {
  const index = layers.findIndex((layer) => layer.id === id);
  if (index === -1) return;
  layers.splice(index, 1);
  if (layers.length === 0) {
    document.removeEventListener("keydown", handleDocumentKeyDown);
  }
  notify();
}

function subscribe(callback: () => void) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

function getAnyOpenSnapshot() {
  return layers.length > 0;
}

/**
 * Registers an open modal/dialog layer for as long as the calling component is
 * mounted. The topmost layer (the most recently mounted) is the only one whose
 * `onRequestClose` runs on Escape. The handler is read through a ref so an
 * always-current closure fires without re-registering the layer on every
 * render.
 */
export function useModalLayer(onRequestClose: () => void): void {
  const id = useId();
  const handlerRef = useRef(onRequestClose);
  handlerRef.current = onRequestClose;

  useEffect(() => {
    pushLayer({ id, onRequestClose: () => handlerRef.current() });
    return () => removeLayer(id);
  }, [id]);
}

/** Whether any app modal/dialog is currently open. */
export function useAnyModalOpen(): boolean {
  return useSyncExternalStore(subscribe, getAnyOpenSnapshot, getAnyOpenSnapshot);
}
