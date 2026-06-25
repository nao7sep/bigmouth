import { ModalShell } from "./ModalShell";

interface ConfirmModalProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Disables both buttons while the confirm action is in flight. */
  busy?: boolean;
  /** A failure from the confirm action, shown in the dialog the user acted in. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const heading = title ?? confirmLabel;

  return (
    <ModalShell title={heading} onClose={onCancel} width={360}>
      <div className="modal-body">
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{message}</p>
        {error && (
          <p className="settings-field-error" style={{ marginTop: 12 }}>
            {error}
          </p>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn-toolbar" onClick={onCancel} autoFocus disabled={busy}>
          {cancelLabel}
        </button>
        <button
          className={danger ? "btn-toolbar btn-delete" : "btn-primary"}
          style={{ width: "auto" }}
          onClick={onConfirm}
          disabled={busy}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
