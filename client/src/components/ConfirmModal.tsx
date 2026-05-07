import { ModalShell } from "./ModalShell";

interface ConfirmModalProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const heading = title ?? confirmLabel;

  return (
    <ModalShell title={heading} onClose={onCancel} width={360}>
      <div className="modal-body">
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{message}</p>
      </div>
      <div className="modal-footer">
        <button className="btn-toolbar" onClick={onCancel} autoFocus>
          {cancelLabel}
        </button>
        <button
          className={danger ? "btn-toolbar btn-delete" : "btn-primary"}
          style={{ width: "auto" }}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
