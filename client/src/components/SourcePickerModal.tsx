import { usePostPicker } from "../hooks/usePostPicker";
import { PostPickerList } from "./PostPickerList";

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
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 520, maxHeight: "75vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Link Source Post</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="modal-body" style={{ overflowY: "auto", flex: 1 }}>
          <PostPickerList
            {...picker}
            autoFocus
            onSelect={(id) => { onSelect(id); onClose(); }}
          />
        </div>
      </div>
    </div>
  );
}
