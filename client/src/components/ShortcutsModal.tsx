import { ModalShell } from "./ModalShell";

interface ShortcutsModalProps {
  onClose: () => void;
}

const SHORTCUTS = [
  { key: "Cmd+N", description: "New post" },
  { key: "Cmd+E", description: "Export" },
  { key: "Cmd+Enter", description: "Run analysis" },
  { key: "Cmd+1", description: "Switch to Analysis tab" },
  { key: "Cmd+2", description: "Switch to Imaging tab" },
  { key: "Cmd+3", description: "Switch to Assets tab" },
  { key: "Cmd+4", description: "Switch to Preview tab" },
  { key: "Cmd+5", description: "Switch to Metadata tab" },
];

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  return (
    <ModalShell title="Keyboard Shortcuts" onClose={onClose} width={420} autoFocusClose>
      <div className="modal-body">
        <table className="shortcuts-table">
          <tbody>
            {SHORTCUTS.map(({ key, description }) => (
              <tr key={key}>
                <td className="shortcut-desc">{description}</td>
                <td className="shortcut-key">
                  <kbd>{key}</kbd>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="shortcuts-note">
          On Windows/Linux, use Ctrl instead of Cmd.
        </p>
      </div>
    </ModalShell>
  );
}
