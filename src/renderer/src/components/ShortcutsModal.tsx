import { ModalShell } from "./ModalShell";

interface ShortcutsModalProps {
  onClose: () => void;
}

// Grouped semantically: post actions, then tab switching, then app dialogs.
// Keys follow the display convention: single platform word, full key names, and
// punctuation spelled as words (Comma, Slash) — no raw symbols or glyphs.
/**
 * Grouped by area, with a note on each group that is scoped — the
 * keyboard-shortcut conventions require one wherever a chord stands down in
 * some context, because advertising an unreachable chord is the same defect as
 * listing one that does not exist.
 */
function buildGroups(mod: string) {
  return [
    {
      title: "App",
      note: null,
      shortcuts: [
        { key: `${mod}+N`, description: "New post" },
        { key: `${mod}+Comma`, description: "Settings" },
        { key: `${mod}+Slash`, description: "Keyboard shortcuts" },
      ],
    },
    {
      title: "Post",
      note: "With a post open.",
      shortcuts: [
        { key: `${mod}+Enter`, description: "Run analysis" },
        { key: `${mod}+E`, description: "Export" },
      ],
    },
    {
      title: "Tabs",
      note: "With a post open. Metadata appears only for targets that require it.",
      shortcuts: [
        { key: `${mod}+1`, description: "Analysis" },
        { key: `${mod}+2`, description: "Imaging" },
        { key: `${mod}+3`, description: "Assets" },
        { key: `${mod}+4`, description: "Preview" },
        { key: `${mod}+5`, description: "Metadata" },
      ],
    },
  ];
}

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  // The single command word for the running platform, per the keyboard-shortcut
  // convention: "Cmd" on macOS, "Ctrl" everywhere else — never the combined form.
  // Mac-first: default to Cmd unless the platform is positively known to be non-macOS.
  const platform = window.bigmouth?.platform;
  const mod = platform && platform !== "darwin" ? "Ctrl" : "Cmd";
  const groups = buildGroups(mod);

  return (
    <ModalShell title="Keyboard Shortcuts" onClose={onClose} width={420} autoFocusClose>
      <div className="modal-body">
        {groups.map((group) => (
          <section key={group.title} className="shortcuts-group">
            <h3 className="shortcuts-group-title">{group.title}</h3>
            {group.note && <p className="shortcuts-group-note">{group.note}</p>}
            <table className="shortcuts-table">
              <tbody>
                {group.shortcuts.map(({ key, description }) => (
                  <tr key={key}>
                    <td className="shortcut-desc">{description}</td>
                    <td className="shortcut-key">
                      <kbd>{key}</kbd>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
      <div className="modal-footer">
        <button className="btn-toolbar" onClick={onClose}>
          Close
        </button>
      </div>
    </ModalShell>
  );
}
