import { useId } from "react";
import { ModalShell } from "./ModalShell";
import { OperationalResult } from "./OperationalResult";
import { useI18n } from "../i18n/I18nContext";
import type { Message } from "@shared/i18n/translate";

interface ConfirmModalProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Disables both buttons while the confirm action is in flight. */
  busy?: boolean;
  /** A failure from the confirm action, shown in the dialog the user acted in. */
  error?: Message | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const { t, text } = useI18n();
  confirmLabel ??= t("common.confirm");
  cancelLabel ??= t("common.cancel");
  const heading = title ?? confirmLabel;
  const messageId = useId();

  return (
    <ModalShell title={heading} onClose={onCancel} width={360} describedBy={messageId}>
      <div className="modal-body">
        {/* Announced with the title: this sentence is the whole content of every
            confirm in the app, and it is what the choice turns on. */}
        <p id={messageId} style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
          {message}
        </p>
        {error && (
          <OperationalResult severity="error" className="modal-result">
            {text(error)}
          </OperationalResult>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn-action" onClick={onCancel} autoFocus disabled={busy}>
          {cancelLabel}
        </button>
        <button
          className={danger ? "btn-action btn-delete-confirm" : "btn-primary"}
          onClick={onConfirm}
          disabled={busy}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
