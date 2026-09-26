import { ModalShell } from "./ModalShell";
import { useI18n } from "../i18n/I18nContext";
import type { MessageKey } from "@shared/i18n/catalogues";

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
// Key tokens stay English on every platform (keyboard-shortcut-conventions);
// only the descriptions and headings are translated.
function buildGroups(mod: string): Array<{
  title: MessageKey;
  note: MessageKey | null;
  shortcuts: Array<{ key: string; description: MessageKey }>;
}> {
  return [
    {
      title: "shortcuts.groupApp",
      note: null,
      shortcuts: [
        { key: `${mod}+N`, description: "shortcuts.newPost" },
        { key: `${mod}+Comma`, description: "settings.title" },
        { key: `${mod}+Slash`, description: "shortcuts.title" },
      ],
    },
    {
      title: "shortcuts.groupPost",
      note: "shortcuts.notePost",
      shortcuts: [
        { key: `${mod}+Enter`, description: "shortcuts.runAnalysis" },
        { key: `${mod}+E`, description: "shortcuts.export" },
      ],
    },
    {
      title: "shortcuts.groupTabs",
      note: "shortcuts.noteTabs",
      shortcuts: [
        { key: `${mod}+1`, description: "tabs.analysis" },
        { key: `${mod}+2`, description: "tabs.imaging" },
        { key: `${mod}+3`, description: "tabs.assets" },
        { key: `${mod}+4`, description: "tabs.preview" },
        { key: `${mod}+5`, description: "tabs.metadata" },
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
  const { t } = useI18n();

  return (
    <ModalShell title={t("shortcuts.title")} onClose={onClose} width={420} autoFocusClose>
      <div className="modal-body">
        {groups.map((group) => (
          <section key={group.title} className="shortcuts-group">
            <h3 className="shortcuts-group-title">{t(group.title)}</h3>
            {group.note && <p className="shortcuts-group-note">{t(group.note)}</p>}
            <table className="shortcuts-table">
              <tbody>
                {group.shortcuts.map(({ key, description }) => (
                  <tr key={key}>
                    <td className="shortcut-desc">{t(description)}</td>
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
        <button className="btn-action" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
    </ModalShell>
  );
}
