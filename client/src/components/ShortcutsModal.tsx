interface ShortcutsModalProps {
  onClose: () => void;
}

const SHORTCUTS = [
  { key: "Cmd+S", description: "Save post immediately" },
  { key: "Cmd+N", description: "New post" },
  { key: "Cmd+E", description: "Open export modal" },
  { key: "Cmd+Enter", description: "Run AI analysis" },
  { key: "Cmd+1", description: "Switch to AI Analysis tab" },
  { key: "Cmd+2", description: "Switch to Assets tab" },
  { key: "Cmd+3", description: "Switch to Preview tab" },
  { key: "Cmd+4", description: "Switch to Metadata tab" },
];

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 420 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Keyboard Shortcuts</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <table className="shortcuts-table">
            <tbody>
              {SHORTCUTS.map(({ key, description }) => (
                <tr key={key}>
                  <td className="shortcut-key">
                    <kbd>{key}</kbd>
                  </td>
                  <td className="shortcut-desc">{description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="shortcuts-note">
            On Windows/Linux, use Ctrl instead of Cmd.
          </p>
        </div>
      </div>
    </div>
  );
}
