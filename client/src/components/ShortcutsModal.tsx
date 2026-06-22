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

const NAV_HINTS: { title: string; body: string }[] = [
  {
    title: "Post list",
    body:
      "Drafts, Checked, Published, and Expired are one list with a single Tab stop. Arrows flow across all sections; Home/End and PageUp/PageDown jump; type a title to jump to it. Moving the cursor does not open a post — press Enter (or Space) to open the one under the cursor. Click a section header to collapse it.",
  },
  {
    title: "Tool & Settings tabs",
    body:
      "One Tab stop per tab bar. Left/Right (and Home/End) move between tabs, switching the panel as the tab is focused. Cmd/Ctrl + 1..5 still jump to a tool tab from anywhere.",
  },
  {
    title: "Menu",
    body:
      "The menu button is the Tab stop. Up/Down (and Home/End) move between items, type-ahead jumps by label, Enter/Space runs an item, and Esc closes the menu.",
  },
  {
    title: "Export format",
    body: "A radio group: arrow keys move between HTML and Plain Text.",
  },
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

        <h3 className="shortcuts-subheading">List, tab &amp; menu navigation</h3>
        <dl className="shortcuts-nav">
          {NAV_HINTS.map(({ title, body }) => (
            <div key={title}>
              <dt>{title}</dt>
              <dd>{body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </ModalShell>
  );
}
