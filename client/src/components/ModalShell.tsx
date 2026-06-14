import { useEffect, useId, useRef } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useModalLayer } from "../hooks/useModalStack";

interface ModalShellProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  maxHeight?: string;
  closeOnBackdrop?: boolean;
  showClose?: boolean;
  autoFocusClose?: boolean;
  modalStyle?: CSSProperties;
  // When a non-interruptible operation is running, disable every close path
  // (backdrop, close button) and mark the surface busy. Escape is gated by the
  // owner's close guard. Defaults to false.
  closeDisabled?: boolean;
}

// Anything the browser will focus, in document order. Excludes explicitly
// untabbable elements; disabled controls are already skipped by the selector.
// The app renders inactive content conditionally (it is removed from the DOM,
// not just hidden), so a visibility filter is unnecessary here.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ModalShell({
  title,
  onClose,
  children,
  width,
  maxHeight,
  closeOnBackdrop = true,
  showClose = true,
  autoFocusClose = false,
  modalStyle,
  closeDisabled = false,
}: ModalShellProps) {
  useModalLayer(onClose);
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Move focus into the dialog on open (unless a child already claimed it via
  // `autoFocus`), and restore it to the trigger on close.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const surface = modalRef.current;
    if (surface && !surface.contains(document.activeElement)) {
      const first = surface.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? surface).focus();
    }
    return () => {
      // Only restore focus if the trigger still exists. The modal's own action
      // can remove it from the DOM (e.g. New Post replaces the list it was
      // opened from); focusing a detached node silently drops focus to <body>.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  // Trap Tab/Shift+Tab within this surface. The handler lives on the surface,
  // so when a dialog is stacked on top, focus is contained in the topmost one
  // and the lower surfaces' handlers never see the event.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const surface = modalRef.current;
    if (!surface) return;

    const focusable = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      event.preventDefault();
      surface.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-backdrop" onClick={closeOnBackdrop && !closeDisabled ? onClose : undefined}>
      <div
        ref={modalRef}
        className="modal"
        style={{ width, maxHeight, ...modalStyle }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={closeDisabled || undefined}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          {showClose && (
            <button
              className="modal-close"
              onClick={onClose}
              disabled={closeDisabled}
              autoFocus={autoFocusClose}
              aria-label="Close"
            >
              &times;
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
