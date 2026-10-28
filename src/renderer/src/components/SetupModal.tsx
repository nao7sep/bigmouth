/**
 * First-run setup, after the workspace window has created the first workspace:
 * it asks for that workspace's first target, the one thing a post cannot be
 * created without, then opens the workspace. The API key is not asked for here;
 * the AI tabs say when one is needed and Settings → AI takes it.
 *
 * The target is saved through the ordinary save path the moment the user
 * finishes, and stays changeable in Settings. A failure stays in place.
 *
 * Like the workspace window in launch-gate mode, it has no Cancel, ✕, backdrop
 * or Escape dismissal, and the modal-dialog conventions permit that for a root
 * launch gate: there is nothing behind it to return to. Its way out is Skip,
 * which opens the workspace without a target: offered where the step cannot be
 * completed (a workspace with no languages). Quitting part-way leaves the workspace
 * registered, and the next launch offers it in the workspace window.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { Target, Workspace } from "@shared/types";
import { getSettings, listTargets, saveTargets } from "../api";
import { presentFailure } from "../util/presentFailure";
import { ModalShell } from "./ModalShell";
import { OperationalResult } from "./OperationalResult";
import { useComposing, isComposingKeyboardEvent } from "../hooks/useComposing";
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";
import { useStorageResultReporter } from "../StorageResults";

interface SetupModalProps {
  /** The workspace the workspace window just created. */
  workspace: Workspace;
  /** Opens the workspace the way choosing one in the workspace window does. */
  onFinish: (workspace: Workspace) => void | Promise<void>;
}

export function SetupModal({ workspace, onFinish }: SetupModalProps) {
  const { t } = useI18n();
  // Opening the workspace awaits the caller; a second click meanwhile must not
  // open it twice.
  const finishing = useRef(false);
  const current = useRef(true);
  useEffect(() => {
    current.current = true;
    return () => { current.current = false; };
  }, []);
  const mayAdopt = () => current.current;
  const finish = () => {
    if (finishing.current || !current.current) return;
    finishing.current = true;
    void onFinish(workspace);
  };

  // Escape and every other close path land here and do nothing: see the header.
  const ignoreClose = () => {};

  return (
    <ModalShell
      title={t("setup.title")}
      onClose={ignoreClose}
      width={520}
      maxHeight="85vh"
      closeOnBackdrop={false}
      showClose={false}
    >
      <TargetStep workspace={workspace} onDone={finish} mayAdopt={mayAdopt} />
    </ModalShell>
  );
}

// --- The first target --------------------------------------------------------

/** The interface language's own code when the workspace offers it, else English, else the first. */
function defaultTargetLanguage(languages: string[], interfaceLanguage: string): string {
  const base = interfaceLanguage.split("-")[0].toLowerCase();
  if (languages.includes(base)) return base;
  if (languages.includes("en")) return "en";
  return languages[0] ?? "";
}

function TargetStep({ workspace, onDone, mayAdopt }: {
  workspace: Workspace; onDone: () => void; mayAdopt: () => boolean;
}) {
  const { t, text, language } = useI18n();
  // The workspace's own targets and languages: a new workspace normally has no
  // targets, and this step adds to any it has rather than replacing them.
  const [loaded, setLoaded] = useState<{ targets: Target[]; languages: string[] } | null>(null);
  const [loadError, setLoadError] = useState<Message | null>(null);
  const [name, setName] = useState(() => t("setup.targetNameDefault"));
  const [targetLanguage, setTargetLanguage] = useState("");
  const [requiresMetadata, setRequiresMetadata] = useState(true);
  const [error, setError] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const current = useRef(true);
  const reportResult = useStorageResultReporter();
  const ownsView = () => current.current && mayAdopt();
  const composing = useComposing();
  const nameId = useId();
  const nameErrorId = useId();
  const languageId = useId();
  const metadataId = useId();
  const loadAttempt = useRef(0);

  const load = () => {
    const attempt = ++loadAttempt.current;
    setLoadError(null);
    setLoaded(null);
    Promise.all([listTargets(workspace.id), getSettings(workspace.id)])
      .then(([targets, settings]) => {
        if (!ownsView() || attempt !== loadAttempt.current) return;
        setLoaded({ targets, languages: settings.supportedLanguages });
        setTargetLanguage(defaultTargetLanguage(settings.supportedLanguages, language));
      })
      .catch((err: unknown) => {
        if (!ownsView() || attempt !== loadAttempt.current) return;
        setLoadError(presentFailure(
          message("setup.targetLoadFailed"),
          "renderer: setup target step load failed",
          err,
          { workspaceId: workspace.id },
        ));
      });
  };

  useEffect(() => {
    current.current = true;
    load();
    return () => { current.current = false; ++loadAttempt.current; };
  }, []);

  const trimmed = name.trim();
  const nameError: Message | null = !trimmed
    ? message("settings.nameRequired")
    : loaded?.targets.some((target) => target.name.trim() === trimmed)
      ? message("settings.targetNameTaken")
      : null;
  const hasLanguages = (loaded?.languages.length ?? 0) > 0;
  const canContinue = loaded !== null && hasLanguages && nameError === null && targetLanguage !== "" && !saving;

  const handleContinue = async () => {
    if (!canContinue || !loaded || savingRef.current || !ownsView()) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await saveTargets(
        [...loaded.targets, { name: trimmed, defaultLanguage: targetLanguage, requiresMetadata }],
        workspace.id,
      );
      if (ownsView()) onDone();
    } catch (err) {
      const failure = presentFailure(
        message("setup.targetSaveFailed"),
        "renderer: setup target save failed",
        err,
        { workspaceId: workspace.id },
      );
      if (ownsView()) {
        setError(failure);
        savingRef.current = false;
        setSaving(false);
      } else reportResult(failure);
    }
  };

  let body;
  if (loadError) {
    body = (
      <div className="workspace-load-recovery">
        <OperationalResult severity="error" className="modal-result">{text(loadError)}</OperationalResult>
        <div className="dialog-actions">
          <button className="btn-action" type="button" onClick={load} autoFocus>{t("common.retry")}</button>
        </div>
      </div>
    );
  } else if (!loaded) {
    body = <p className="modal-empty-message">{t("common.loading")}</p>;
  } else if (!hasLanguages) {
    body = (
      <OperationalResult severity="warning" className="modal-result">
        {t("setup.targetNeedsLanguage")}
      </OperationalResult>
    );
  } else {
    body = (
      <>
        <div className="form-field">
          <label className="form-label" htmlFor={nameId}>{t("workspaces.name")}</label>
          <input
            id={nameId}
            className="form-input"
            value={name}
            onChange={(e) => {
              setError(null);
              setName(e.target.value);
            }}
            onCompositionStart={composing.handlers.onCompositionStart}
            onCompositionEnd={composing.handlers.onCompositionEnd}
            onKeyDown={(e) => {
              if (isComposingKeyboardEvent(composing.composingRef, e)) return;
              if (e.key === "Enter") void handleContinue();
            }}
            aria-invalid={nameError !== null || undefined}
            aria-describedby={nameError ? nameErrorId : undefined}
            autoFocus
            disabled={saving}
          />
          {nameError && <p id={nameErrorId} className="settings-field-error">{text(nameError)}</p>}
        </div>
        <div className="form-row">
          <div className="form-field" style={{ flex: 1 }}>
            <label className="form-label" htmlFor={languageId}>{t("newPost.language")}</label>
            <select
              id={languageId}
              className="form-select"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              disabled={saving}
            >
              {loaded.languages.map((lang) => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ flex: 1 }}>
            <label className="form-label" htmlFor={metadataId}>{t("settings.requiresMetadata")}</label>
            <select
              id={metadataId}
              className="form-select"
              value={requiresMetadata ? "yes" : "no"}
              onChange={(e) => setRequiresMetadata(e.target.value === "yes")}
              disabled={saving}
            >
              <option value="yes">{t("common.yes")}</option>
              <option value="no">{t("common.no")}</option>
            </select>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="modal-body">
        <h3 className="setup-heading">{t("setup.targetHeading")}</h3>
        <p className="setup-intro">{t("setup.targetIntro")}</p>
        {body}
        {error && (
          <OperationalResult severity="error" className="modal-result">
            {text(error)}
          </OperationalResult>
        )}
      </div>
      <div className="modal-footer">
        {/* Skipping is offered only where the step cannot be completed here: a
            workspace with no languages has nothing to give a target. */}
        {loaded && !hasLanguages ? (
          <button className="btn-primary" onClick={onDone} autoFocus>
            {t("setup.skip")}
          </button>
        ) : (
          <button className="btn-primary" onClick={() => void handleContinue()} disabled={!canContinue}>
            {saving ? t("common.saving") : t("setup.finish")}
          </button>
        )}
      </div>
    </>
  );
}
