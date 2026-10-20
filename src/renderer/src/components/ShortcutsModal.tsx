import { ModalShell } from "./ModalShell";
import { useI18n } from "../i18n/I18nContext";
import { SHORTCUT_GROUPS, shortcutKeys } from "../util/shortcuts";

interface ShortcutsModalProps {
  onClose: () => void;
}

/**
 * The dialog lists the shortcut table the key handlers match against. Keys
 * follow the display convention: the running platform's single modifier word,
 * full key names and punctuation spelled as words, in English on every
 * platform; only the descriptions and headings are translated.
 */
export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  // The single command word for the running platform, per the keyboard-shortcut
  // convention: "Cmd" on macOS, "Ctrl" everywhere else — never the combined form.
  // Mac-first: default to Cmd unless the platform is positively known to be non-macOS.
  const platform = window.bigmouth?.platform;
  const mod = platform && platform !== "darwin" ? "Ctrl" : "Cmd";
  const { t } = useI18n();

  return (
    <ModalShell title={t("shortcuts.title")} onClose={onClose} width={640} autoFocusClose>
      <div className="modal-body shortcuts-groups">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className="shortcuts-group">
            <h3 className="shortcuts-group-title">{t(group.title)}</h3>
            {group.note && <p className="shortcuts-group-note">{t(group.note)}</p>}
            <table className="shortcuts-table">
              <tbody>
                {group.shortcuts.map((shortcut) => (
                  <tr key={shortcut.description}>
                    <td className="shortcut-desc">{t(shortcut.description)}</td>
                    <td className="shortcut-key">
                      <kbd>{shortcutKeys(shortcut, mod)}</kbd>
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
