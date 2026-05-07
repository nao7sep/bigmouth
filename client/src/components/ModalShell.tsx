import type { CSSProperties, ReactNode } from "react";
import { useEscapeKey } from "../hooks/useEscapeKey";

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
}

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
}: ModalShellProps) {
  useEscapeKey(onClose);

  return (
    <div className="modal-backdrop" onClick={closeOnBackdrop ? onClose : undefined}>
      <div
        className="modal"
        style={{ width, maxHeight, ...modalStyle }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          {showClose && (
            <button className="modal-close" onClick={onClose} autoFocus={autoFocusClose}>
              &times;
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
