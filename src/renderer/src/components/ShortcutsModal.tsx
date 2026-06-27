import { ModalShell } from "./ModalShell";

interface ShortcutsModalProps {
  onClose: () => void;
}

// Grouped semantically: post actions, then tab switching, then app dialogs.
// Keys follow the display convention: single platform word, full key names, and
// punctuation spelled as words (Comma, Slash) — no raw symbols or glyphs.
function buildShortcuts(mod: string) {
  return [
    { key: `${mod}+N`, description: "New post" },
    { key: `${mod}+Enter`, description: "Run analysis" },
    { key: `${mod}+E`, description: "Export" },
    { key: `${mod}+1`, description: "Analysis tab" },
    { key: `${mod}+2`, description: "Imaging tab" },
    { key: `${mod}+3`, description: "Assets tab" },
    { key: `${mod}+4`, description: "Preview tab" },
    { key: `${mod}+5`, description: "Metadata tab" },
    { key: `${mod}+Comma`, description: "Settings" },
    { key: `${mod}+Slash`, description: "Keyboard shortcuts" },
  ];
}

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  // The single command word for the running platform, per the keyboard-shortcut
  // convention: "Cmd" on macOS, "Ctrl" everywhere else — never the combined form.
  // Mac-first: default to Cmd unless the platform is positively known to be non-macOS.
  const platform = window.bigmouth?.platform;
  const mod = platform && platform !== "darwin" ? "Ctrl" : "Cmd";
  const shortcuts = buildShortcuts(mod);

  return (
    <ModalShell title="Keyboard Shortcuts" onClose={onClose} width={420} autoFocusClose>
      <div className="modal-body">
        <table className="shortcuts-table">
          <tbody>
            {shortcuts.map(({ key, description }) => (
              <tr key={key}>
                <td className="shortcut-desc">{description}</td>
                <td className="shortcut-key">
                  <kbd>{key}</kbd>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="modal-footer">
        <button className="btn-toolbar" onClick={onClose}>
          Close
        </button>
      </div>
    </ModalShell>
  );
}
