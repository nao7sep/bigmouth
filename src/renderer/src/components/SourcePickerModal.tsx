import { usePostPicker } from "../hooks/usePostPicker";
import { PostPickerList } from "./PostPickerList";
import { ModalShell } from "./ModalShell";
import { useI18n } from "../i18n/I18nContext";

interface SourcePickerModalProps {
  currentPostId: string;
  pubBatchSize: number;
  onSelect: (sourceId: string) => void;
  onClose: () => void;
}

export function SourcePickerModal({
  currentPostId,
  pubBatchSize,
  onSelect,
  onClose,
}: SourcePickerModalProps) {
  const picker = usePostPicker(pubBatchSize, currentPostId);
  const { t } = useI18n();

  return (
    <ModalShell
      title={t("sourcePicker.title")}
      onClose={onClose}
      width={520}
      maxHeight="75vh"
      modalStyle={{ display: "flex", flexDirection: "column" }}
    >
      <div className="modal-body" style={{ overflowY: "auto", flex: 1 }}>
        <PostPickerList
          {...picker}
          autoFocus
          onSelect={(id) => { onSelect(id); onClose(); }}
        />
      </div>
      <div className="modal-footer">
        <button className="btn-action" onClick={onClose}>
          {t("common.cancel")}
        </button>
      </div>
    </ModalShell>
  );
}
