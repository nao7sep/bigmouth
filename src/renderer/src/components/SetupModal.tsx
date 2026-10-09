/**
 * First-run setup — the app's root launch gate when no workspace is registered
 * at all, so there is nothing to open.
 *
 * It asks one thing per step, in the order the first useful work needs them
 * (config-sets conventions, "First-run setup"): the workspace, its first target,
 * and the optional Anthropic API key. Each step commits through the ordinary
 * save path the moment the user continues — openOrCreateWorkspace, saveTargets,
 * saveAnthropicSettings — so a skipped step writes nothing and every choice
 * stays changeable in Settings. A failure stays in place on its step.
 *
 * Like the workspace picker in launch-gate mode, it has no Cancel, ✕, backdrop
 * or Escape dismissal, and the modal-dialog conventions permit that for a root
 * launch gate: there is nothing behind it to return to, and dismissing it would
 * leave the user with no workspace and no way forward. The way out of the
 * guided path is "Open Existing Workspace", which hands over to the picker.
 * Once the workspace step has run, a workspace exists; quitting part-way leaves
 * it registered, and the next launch offers it in the picker.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { AnthropicSettingsView, Target, Workspace } from "@shared/types";
import { PROVIDER_LABELS } from "@shared/aiModels";
import {
  getAnthropicSettings,
  getSettings,
  listTargets,
  openOrCreateWorkspace,
  pickWorkspaceDirectory,
  reportProblem,
  saveAnthropicSettings,
  saveTargets,
  suggestWorkspaceLocation,
} from "../api";
import { presentFailure } from "../util/presentFailure";
import { ModalShell } from "./ModalShell";
import { OperationalResult } from "./OperationalResult";
import { useComposing, isComposingKeyboardEvent } from "../hooks/useComposing";
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";

type Step = "workspace" | "target" | "key";

interface SetupModalProps {
  /** Opens the finished workspace the way choosing one in the picker does. */
  onFinish: (workspace: Workspace) => void | Promise<void>;
  /** Leaves setup for the workspace picker, to open a folder that already exists. */
  onOpenExisting: () => void;
}

export function SetupModal({ onFinish, onOpenExisting }: SetupModalProps) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>("workspace");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  // Opening the workspace awaits the caller; a second click meanwhile must not
  // open it twice.
  const finishing = useRef(false);

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
      {step === "workspace" && (
        <WorkspaceStep
          onCreated={(created) => {
            setWorkspace(created);
            setStep("target");
          }}
          onOpenExisting={onOpenExisting}
        />
      )}
      {step === "target" && workspace && (
        <TargetStep workspace={workspace} onDone={() => setStep("key")} />
      )}
      {step === "key" && workspace && (
        <KeyStep
          workspace={workspace}
          onDone={() => {
            if (finishing.current) return;
            finishing.current = true;
            void onFinish(workspace);
          }}
        />
      )}
    </ModalShell>
  );
}

// --- The workspace -----------------------------------------------------------

function WorkspaceStep({
  onCreated,
  onOpenExisting,
}: {
  onCreated: (workspace: Workspace) => void;
  onOpenExisting: () => void;
}) {
  const { t, text } = useI18n();
  const [name, setName] = useState(() => t("setup.workspaceNameDefault"));
  // The location follows the name's suggested folder until the user types or
  // browses one; from then on it is theirs. Left untouched, creation is asked
  // for the default rather than handed the suggestion, so it applies the same
  // rule at the moment it creates.
  const [location, setLocation] = useState("");
  const [locationEdited, setLocationEdited] = useState(false);
  const [suggestion, setSuggestion] = useState("");
  const [error, setError] = useState<Message | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameComposing = useComposing();
  const locationComposing = useComposing();
  const nameId = useId();
  const locationId = useId();

  useEffect(() => {
    let current = true;
    suggestWorkspaceLocation(name.trim() || undefined)
      .then((path) => {
        if (current) setSuggestion(path);
      })
      .catch((err: unknown) => {
        // Only the preview is lost: creation still resolves the default itself.
        if (current) setSuggestion("");
        reportProblem("renderer: workspace location suggestion failed", err);
      });
    return () => {
      current = false;
    };
  }, [name]);

  const shownLocation = locationEdited ? location : suggestion;

  const handleBrowse = async () => {
    try {
      const dir = await pickWorkspaceDirectory();
      if (dir) {
        setError(null);
        setLocation(dir);
        setLocationEdited(true);
      }
    } catch (err) {
      setError(presentFailure(
        message("workspaces.pickerFailed"),
        "renderer: setup workspace folder picker failed",
        err,
      ));
    }
  };

  const handleContinue = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const chosen = locationEdited && location !== "" ? location : undefined;
      onCreated(await openOrCreateWorkspace(name.trim() || undefined, chosen));
    } catch (err) {
      setError(presentFailure(
        message("workspaces.openFailed"),
        "renderer: setup workspace open or creation failed",
        err,
      ));
      setSubmitting(false);
    }
  };

  const submitOnEnter = (composing: ReturnType<typeof useComposing>) => (e: KeyboardEvent) => {
    if (isComposingKeyboardEvent(composing.composingRef, e)) return;
    if (e.key === "Enter") void handleContinue();
  };

  return (
    <>
      <div className="modal-body">
        <h3 className="setup-heading">{t("setup.workspaceHeading")}</h3>
        <p className="setup-intro">{t("setup.workspaceIntro")}</p>
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
            onCompositionStart={nameComposing.handlers.onCompositionStart}
            onCompositionEnd={nameComposing.handlers.onCompositionEnd}
            onKeyDown={submitOnEnter(nameComposing)}
            autoFocus
          />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor={locationId}>{t("workspaces.location")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              id={locationId}
              className="form-input"
              style={{ flex: 1 }}
              spellCheck={false}
              value={shownLocation}
              placeholder={suggestion}
              onChange={(e) => {
                setError(null);
                setLocation(e.target.value);
                setLocationEdited(true);
              }}
              onCompositionStart={locationComposing.handlers.onCompositionStart}
              onCompositionEnd={locationComposing.handlers.onCompositionEnd}
              onKeyDown={submitOnEnter(locationComposing)}
            />
            <button className="btn-action" type="button" onClick={() => void handleBrowse()} disabled={submitting}>
              {t("common.browse")}
            </button>
          </div>
          <p className="settings-hint">{t("setup.locationHint")}</p>
        </div>
        {error && (
          <OperationalResult severity="error" className="modal-result">
            {text(error)}
          </OperationalResult>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn-action" onClick={onOpenExisting} disabled={submitting}>
          {t("setup.openExisting")}
        </button>
        <button className="btn-primary" onClick={() => void handleContinue()} disabled={submitting}>
          {submitting ? t("workspaces.opening") : t("setup.continue")}
        </button>
      </div>
    </>
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

function TargetStep({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const { t, text, language } = useI18n();
  // The workspace's own targets and languages: a new workspace has no targets,
  // but the workspace step may have opened an existing one, whose targets this
  // step adds to rather than replaces.
  const [loaded, setLoaded] = useState<{ targets: Target[]; languages: string[] } | null>(null);
  const [loadError, setLoadError] = useState<Message | null>(null);
  const [name, setName] = useState(() => t("setup.targetNameDefault"));
  const [targetLanguage, setTargetLanguage] = useState("");
  const [requiresMetadata, setRequiresMetadata] = useState(true);
  const [error, setError] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);
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
        if (attempt !== loadAttempt.current) return;
        setLoaded({ targets, languages: settings.supportedLanguages });
        setTargetLanguage(defaultTargetLanguage(settings.supportedLanguages, language));
      })
      .catch((err: unknown) => {
        if (attempt !== loadAttempt.current) return;
        setLoadError(presentFailure(
          message("setup.targetLoadFailed"),
          "renderer: setup target step load failed",
          err,
          { workspaceId: workspace.id },
        ));
      });
  };

  useEffect(() => {
    load();
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
    if (!canContinue || !loaded) return;
    setSaving(true);
    setError(null);
    try {
      await saveTargets(
        [...loaded.targets, { name: trimmed, defaultLanguage: targetLanguage, requiresMetadata }],
        workspace.id,
      );
      onDone();
    } catch (err) {
      setError(presentFailure(
        message("setup.targetSaveFailed"),
        "renderer: setup target save failed",
        err,
        { workspaceId: workspace.id },
      ));
      setSaving(false);
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
        {/* Skipping is offered only where the step cannot be completed here:
            a workspace with no languages has nothing to give a target. */}
        {loaded && !hasLanguages ? (
          <button className="btn-primary" onClick={onDone} autoFocus>
            {t("setup.skip")}
          </button>
        ) : (
          <button className="btn-primary" onClick={() => void handleContinue()} disabled={!canContinue}>
            {saving ? t("common.saving") : t("setup.continue")}
          </button>
        )}
      </div>
    </>
  );
}

// --- The Anthropic API key ---------------------------------------------------

function KeyStep({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const { t, text } = useI18n();
  const [apiKey, setApiKey] = useState("");
  // The section as stored, for its hints: whether a key is already stored, or
  // the environment supplies one. Saving reads it afresh.
  const [view, setView] = useState<AnthropicSettingsView | null>(null);
  const [error, setError] = useState<Message | null>(null);
  // Where this save moved a damaged key file: the key is saved, and the notice
  // stays on screen until the user finishes, as it does in Settings.
  const [savedNotice, setSavedNotice] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);
  const composing = useComposing();
  const keyId = useId();
  const noticeId = useId();

  useEffect(() => {
    let current = true;
    getAnthropicSettings(workspace.id)
      .then((loaded) => {
        if (current) setView(loaded);
      })
      .catch((err: unknown) => {
        // Only the hints are lost; saving reads the section again and says so
        // in place if it still cannot.
        reportProblem("renderer: setup Anthropic settings load failed", err, { workspaceId: workspace.id });
      });
    return () => {
      current = false;
    };
  }, [workspace.id]);

  const canSave = apiKey.trim() !== "" && !saving && savedNotice === null;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const { endpoint, models, thinking } = await getAnthropicSettings(workspace.id);
      const saved = await saveAnthropicSettings({ endpoint, models, thinking, apiKey }, workspace.id);
      if (saved.keyNotice?.key === "settings.keyFileMovedAside") {
        setSavedNotice(saved.keyNotice);
        setSaving(false);
        return;
      }
      onDone();
    } catch (err) {
      setError(presentFailure(
        message("setup.keySaveFailed"),
        "renderer: setup API key save failed",
        err,
        { workspaceId: workspace.id },
      ));
      setSaving(false);
    }
  };

  const loadNotice = view?.keyNotice && savedNotice === null ? view.keyNotice : null;

  return (
    <>
      <div className="modal-body">
        <h3 className="setup-heading">{t("setup.keyHeading")}</h3>
        <p className="setup-intro">{t("setup.keyIntro", { provider: PROVIDER_LABELS.anthropic })}</p>
        <div className="form-field">
          <label className="form-label" htmlFor={keyId}>
            {t("settings.apiKey")} <span style={{ color: "var(--bm-text-muted)", fontWeight: 400 }}>{t("common.optional")}</span>
          </label>
          <input
            id={keyId}
            className="form-input"
            type="password"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => {
              setError(null);
              setApiKey(e.target.value);
            }}
            onCompositionStart={composing.handlers.onCompositionStart}
            onCompositionEnd={composing.handlers.onCompositionEnd}
            onKeyDown={(e) => {
              if (isComposingKeyboardEvent(composing.composingRef, e)) return;
              if (e.key === "Enter") void handleSave();
            }}
            placeholder={view?.hasApiKey ? t("settings.apiKeyKeep") : undefined}
            aria-describedby={loadNotice ? noticeId : undefined}
            disabled={saving || savedNotice !== null}
            autoFocus
          />
          {view?.usingEnvKey && (
            <p className="settings-hint">{t("settings.envKey", { variable: "ANTHROPIC_API_KEY" })}</p>
          )}
          {loadNotice && <p id={noticeId} className="settings-field-error">{text(loadNotice)}</p>}
        </div>
        {savedNotice && (
          <OperationalResult severity="warning" className="modal-result">
            {text(savedNotice)}
          </OperationalResult>
        )}
        {error && (
          <OperationalResult severity="error" className="modal-result">
            {text(error)}
          </OperationalResult>
        )}
      </div>
      <div className="modal-footer">
        {savedNotice ? (
          <button className="btn-primary" onClick={onDone} autoFocus>
            {t("setup.finish")}
          </button>
        ) : (
          <>
            <button className="btn-action" onClick={onDone} disabled={saving}>
              {t("setup.skip")}
            </button>
            <button className="btn-primary" onClick={() => void handleSave()} disabled={!canSave}>
              {saving ? t("common.saving") : t("setup.finish")}
            </button>
          </>
        )}
      </div>
    </>
  );
}
