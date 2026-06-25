import { usePostPicker } from "../hooks/usePostPicker";
import { PostPickerList } from "./PostPickerList";
import { ModalShell } from "./ModalShell";

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

  return (
    <ModalShell
      title="Link Source Post"
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
    </ModalShell>
  );
}
