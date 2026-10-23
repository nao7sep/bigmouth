import { useEffect, useId, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { AppSettings, Settings, Target, AnalysisPrompt, AnthropicSettingsView, GenerationPromptsData, Workspace } from "@shared/types";
import { AI_ROLE_IDS, PROVIDER_LABELS, hasThinkingChoice, rowFor, thinkingAfterModelEdit, type AiRole } from "@shared/aiModels";
import { duplicateConfigNames, isEndpoint } from "@shared/configSets";
import { THEME_PREFERENCES } from "@shared/appSettings";
import { SYSTEM_TIME_ZONE, systemTimeZone, timeZoneOptions } from "@shared/timeZone";
import { LANGUAGE_NAMES, LANGUAGES, languageNameIn, normalizeLanguagePreference, type Language } from "@shared/i18n/languages";
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";
import type { MessageKey } from "@shared/i18n/catalogues";
import {
  CONTENT_FONT_SIZE_MAX,
  CONTENT_FONT_SIZE_MIN,
  CONTENT_LINE_HEIGHT_MAX,
  CONTENT_LINE_HEIGHT_MIN,
  CONTENT_PADDING_MAX,
  CONTENT_PADDING_MIN,
} from "@shared/types";
import { firstSettingsError, settingsFieldErrors } from "@shared/settingsValidation";
import {
  getAppSettings,
  saveAppSettings,
  getSettings,
  saveSettings,
  listTargets,
  saveTargets,
  updateWorkspace,
  renameTarget,
  listAnalysisPrompts,
  listAnalysisPromptDefaults,
  saveAnalysisPrompts,
  getAnthropicSettings,
  saveAnthropicSettings,
  getGenerationPrompts,
  getGenerationPromptDefaults,
  saveGenerationPrompts,
  rebuildPostIndex,
} from "../api";
import { presentFailure } from "../util/presentFailure";
import {
  GENERATION_PROMPT_KEYS,
  GENERATION_PROMPT_LABELS,
} from "../generationPromptDefaults";
import { useConfirm } from "./ConfirmHost";
import { ModalShell } from "./ModalShell";
import { useTablist } from "../hooks/useTablist";
import { OperationalResult } from "./OperationalResult";
import { ListedMessageView, type ListedMessage } from "./NamedItems";
import { finalSegment } from "../util/shortenedText";
import { StoragePendingNotice, useStoragePending, useStorageResultReporter } from "../StoragePending";

interface SettingsModalProps {
  workspaceId: string;
  /** The workspace's name as the app knows it; Settings edits it alongside the rest. */
  workspaceName: string;
  /** The workspace's folder, shown for reference: a workspace is never moved. */
  workspaceFolder: string;
  onClose: () => void;
  onSettingsChanged: () => void;
  /** A saved rename, so the open workspace shows its new name. */
  onWorkspaceRenamed: (workspace: Workspace) => void;
}

/** A post file a target rename could not read, with the target it still names. */
type RenameSkip = { fileName: string; reason: string; oldName: string };

/**
 * One result for every file a rename skipped, whether this editor shows it or
 * the app shell does after Settings has closed: a few file names, then the full
 * list with each file's target and reason behind a disclosure.
 */
function renameSkipsResult(skips: readonly RenameSkip[]): ListedMessage {
  return {
    message: message("settings.renameSkipped", { count: skips.length }),
    items: skips.map((skip) => ({
      name: finalSegment(skip.fileName),
      line: message("settings.renameSkippedFile", { file: skip.fileName, target: skip.oldName, reason: skip.reason }),
    })),
  };
}

type Tab = "general" | "targets" | "ai" | "analysis" | "generation";

/** The Anthropic section as Settings edits it: the loaded view plus a key the user typed. */
type AnthropicDraft = AnthropicSettingsView & { apiKey: string };

type EditableTarget = Target & {
  rowId: string;
  originalName?: string;
};

const TABS: Tab[] = ["general", "targets", "ai", "analysis", "generation"];

const TAB_LABELS: Record<Tab, MessageKey> = {
  general: "settings.tabGeneral",
  targets: "settings.tabTargets",
  ai: "settings.tabAi",
  analysis: "tabs.analysis",
  generation: "settings.tabGeneration",
};

function editableTargets(targets: Target[]): EditableTarget[] {
  return targets.map((target) => ({
    ...target,
    rowId: nanoid(),
    originalName: target.name,
  }));
}

function targetPayload(targets: EditableTarget[]): Target[] {
  return targets.map(({ name, defaultLanguage, requiresMetadata }) => ({
    name: name.trim(),
    defaultLanguage: defaultLanguage.trim(),
    requiresMetadata,
  }));
}

export function SettingsModal({
  workspaceId,
  workspaceName,
  workspaceFolder,
  onClose,
  onSettingsChanged,
  onWorkspaceRenamed,
}: SettingsModalProps) {
  const { t, text } = useI18n();
  const storagePending = useStoragePending();
  const reportStorageResult = useStorageResultReporter();
  const current = useRef(true);
  const savingRef = useRef(false);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const close = () => { if (!current.current) return; current.current = false; onClose(); };
  const [tab, setTab] = useState<Tab>("general");
  // The workspace's name lives in the app's workspace list, not in the
  // workspace's settings file, and saves to it on the same Save.
  const [name, setName] = useState(workspaceName);
  const initialName = useRef(workspaceName);
  const [settings, setSettings] = useState<Settings | null>(null);
  // App-wide (the storage root's config.json), edited and saved with the
  // workspace's own settings so the theme applies on Save like everything else.
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  // What System resolves to as Settings opens, shown beside it.
  const [systemAppearance, setSystemAppearance] = useState<"light" | "dark">("light");
  const [systemLanguage, setSystemLanguage] = useState<Language>("en");
  const [anthropic, setAnthropic] = useState<AnthropicDraft | null>(null);
  const [generationPrompts, setGenerationPrompts] = useState<GenerationPromptsData | null>(null);
  const [generationPromptDefaults, setGenerationPromptDefaults] = useState<GenerationPromptsData | null>(null);
  const [targets, setTargets] = useState<EditableTarget[]>([]);
  const [prompts, setPrompts] = useState<AnalysisPrompt[]>([]);
  const [analysisPromptDefaults, setAnalysisPromptDefaults] = useState<AnalysisPrompt[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Message | null>(null);
  // Post files a target rename could not read. Settings saved, but those posts
  // still name the retired target, so Settings stays open to say which.
  const [renameSkips, setRenameSkips] = useState<RenameSkip[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<Message | null>(null);
  const confirm = useConfirm();

  // Snapshot of the loaded values, used for dirty detection.
  const initialSettings = useRef<Settings | null>(null);
  const initialAppSettings = useRef<AppSettings | null>(null);
  const initialAnthropic = useRef<AnthropicDraft | null>(null);
  // The last listed id each role's model field has held while the modal is open; it
  // outlives the AI tab, which unmounts when another tab is shown.
  const lastListedModels = useRef<Partial<Record<AiRole, string>>>({});
  const initialGenerationPrompts = useRef<GenerationPromptsData | null>(null);
  const initialTargets = useRef<EditableTarget[]>([]);
  const initialPrompts = useRef<AnalysisPrompt[]>([]);

  // Load every resource all-or-nothing: a partial failure must not seed empty
  // state, because Save persists every field and would overwrite the missing
  // ones on disk (e.g. an empty targets list). On failure nothing is seeded and
  // the editor stays gated behind the load error.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getAppSettings(),
      getSettings(workspaceId),
      getAnthropicSettings(workspaceId),
      getGenerationPromptDefaults(workspaceId),
      getGenerationPrompts(workspaceId),
      listTargets(workspaceId, true),
      listAnalysisPromptDefaults(workspaceId),
      listAnalysisPrompts(workspaceId, true),
    ])
      .then(([app, s, ai, genDefaults, gen, tgts, analysisDefaults, analysisPrompts]) => {
        if (cancelled) return;
        setAppSettings(app.settings);
        setSystemAppearance(app.systemAppearance);
        setSystemLanguage(app.systemLanguage);
        initialAppSettings.current = app.settings;
        setSettings(s);
        initialSettings.current = s;
        const draft = { ...ai, apiKey: "" };
        setAnthropic(draft);
        initialAnthropic.current = draft;
        setGenerationPromptDefaults(genDefaults);
        setGenerationPrompts(gen);
        initialGenerationPrompts.current = gen;
        const editable = editableTargets(tgts);
        setTargets(editable);
        initialTargets.current = editable;
        setAnalysisPromptDefaults(analysisDefaults);
        setPrompts(analysisPrompts);
        initialPrompts.current = analysisPrompts;
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(presentFailure(
          message("settings.loadFailed"),
          "renderer: settings load failed",
          err,
        ));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const appSettingsDirty =
    JSON.stringify(appSettings) !== JSON.stringify(initialAppSettings.current);
  const settingsDirty = JSON.stringify(settings) !== JSON.stringify(initialSettings.current);
  const generationDirty = JSON.stringify(generationPrompts) !== JSON.stringify(initialGenerationPrompts.current);
  const analysisDirty = JSON.stringify(prompts) !== JSON.stringify(initialPrompts.current);
  const targetsDirty = JSON.stringify(targetPayload(targets)) !== JSON.stringify(targetPayload(initialTargets.current));
  const anthropicDirty = JSON.stringify(anthropic) !== JSON.stringify(initialAnthropic.current);
  const nameDirty = name.trim() !== initialName.current.trim();
  const isDirty =
    nameDirty || appSettingsDirty || settingsDirty || generationDirty || analysisDirty || targetsDirty || anthropicDirty;

  const handleRequestClose = async () => {
    if (!current.current) return;
    if (savingRef.current) { if (storagePending) close(); return; }
    if (!isDirty) { close(); return; }
    const ok = await confirm({
      title: t("common.discardTitle"),
      message: t("common.discardMessage"),
      confirmLabel: t("common.discard"),
      cancelLabel: t("common.keepEditing"),
      danger: true,
    });
    if (ok && current.current) close();
  };

  const isValid = (): boolean => {
    if (!settings) return false;
    if (!name.trim()) return false;
    // The settings fields answer from the one module the inputs render their
    // messages from, so an inline error can never sit beside an enabled Save.
    if (firstSettingsError(settings) !== null) return false;
    if (anthropic && (!isEndpoint(anthropic.endpoint) || AI_ROLE_IDS.some((role) => !anthropic.models[role].trim()))) {
      return false;
    }
    const tNames = targets.map((t) => t.name.trim());
    if (tNames.some((n) => !n) || duplicateConfigNames(targets).size > 0) return false;
    if (prompts.some((p) => !p.name.trim() || !p.text.trim()) || duplicateConfigNames(prompts).size > 0) return false;
    return true;
  };

  // Save requires both dirty and valid: re-persisting an unchanged form is a
  // no-op that the convention asks us to disable.
  const canSave = !saving && !storagePending && isDirty && isValid();

  const { tablistProps, getTabProps, getPanelProps } = useTablist<Tab>({
    tabs: TABS,
    selected: tab,
    onSelect: setTab,
    idBase: "settings",
  });

  const handleSaveAll = async () => {
    if (savingRef.current || storagePending || !appSettings || !settings || !anthropic || !generationPrompts) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setRenameSkips([]);
    try {
      const renames = (duplicateConfigNames(initialTargets.current).size > 0 ? [] : targets)
        .map((target) => ({
          oldName: target.originalName?.trim() ?? "",
          newName: target.name.trim(),
        }))
        .filter(({ oldName, newName }) => oldName && newName && oldName !== newName);

      const { endpoint, models, thinking, apiKey } = anthropic;
      const saves = [
        appSettingsDirty ? saveAppSettings(appSettings) : Promise.resolve(appSettings),
        settingsDirty ? saveSettings(settings, workspaceId) : Promise.resolve(settings),
        anthropicDirty
          ? saveAnthropicSettings({ endpoint, models, thinking, ...(apiKey.trim() ? { apiKey } : {}) }, workspaceId)
          : Promise.resolve(anthropic),
        generationDirty ? saveGenerationPrompts(generationPrompts, workspaceId) : Promise.resolve(generationPrompts),
        analysisDirty ? saveAnalysisPrompts(prompts, workspaceId) : Promise.resolve(prompts),
        // A saved name is reported at once, even if a sibling save fails: the
        // workspace list already holds it, so the app must show it.
        nameDirty
          ? updateWorkspace(workspaceId, { name: name.trim() }).then((saved) => {
              onWorkspaceRenamed(saved);
              if (current.current) {
                setName(saved.name);
                initialName.current = saved.name;
              }
              return saved;
            })
          : Promise.resolve(null),
      ] as const;
      const [savedAppSettings, savedSettings, savedAnthropic, savedGenPrompts, savedPrompts] = await Promise.all(saves).catch(async (error: unknown) => {
        // One refused set does not cancel the other already submitted writes.
        // Keep this Save owned and non-repeatable until all of them settle.
        await Promise.allSettled(saves);
        throw error;
      });

      const skips: RenameSkip[] = [];
      for (const { oldName, newName } of renames) {
        const { postsSkipped } = await renameTarget(oldName, newName, workspaceId);
        for (const file of postsSkipped) skips.push({ ...file, oldName });
      }
      const savedTargets = targetsDirty ? await saveTargets(targetPayload(targets), workspaceId) : targetPayload(targets);

      // The submitted workspace intent still finishes after leaving. Only its
      // original live editor may adopt snapshots or close itself.
      onSettingsChanged();
      if (!current.current) {
        if (skips.length > 0) reportStorageResult(renameSkipsResult(skips), "warning");
        if (savedAnthropic.keyNotice?.key === "settings.keyFileMovedAside") reportStorageResult(savedAnthropic.keyNotice, "warning");
        return;
      }
      setAppSettings(savedAppSettings);
      initialAppSettings.current = savedAppSettings;
      const savedDraft = { ...savedAnthropic, apiKey: "" };
      setAnthropic(savedDraft);
      initialAnthropic.current = savedDraft;
      setSettings(savedSettings);
      initialSettings.current = savedSettings;
      setGenerationPrompts(savedGenPrompts);
      initialGenerationPrompts.current = savedGenPrompts;
      const editableSavedTargets = editableTargets(savedTargets);
      setTargets(editableSavedTargets);
      initialTargets.current = editableSavedTargets;
      setPrompts(savedPrompts);
      initialPrompts.current = savedPrompts;
      // Where this save moved a damaged key file stays on screen, like a rename
      // that skipped posts.
      if (skips.length > 0) setRenameSkips(skips);
      else if (savedAnthropic.keyNotice?.key !== "settings.keyFileMovedAside") close();
    } catch (err) {
      const failure = presentFailure(message(current.current ? "settings.saveFailed" : "app.storageChangeFailed"), "renderer: settings save failed", err);
      if (current.current) setSaveError(failure);
      else reportStorageResult(failure);
    } finally {
      savingRef.current = false;
      if (current.current) setSaving(false);
    }
  };

  return (
    <ModalShell
      title={t("settings.title")}
      onClose={() => void handleRequestClose()}
      width={560}
      maxHeight="85vh"
      closeDisabled={saving && !storagePending}
    >
      <StoragePendingNotice />
      {loadError ? (
        <div className="modal-body">
          <OperationalResult severity="error" className="modal-result">
            {text(loadError)}
          </OperationalResult>
        </div>
      ) : !loaded ? (
        <div className="modal-body">
          <p>{t("common.loading")}</p>
        </div>
      ) : (
        <>
          <div className="settings-tabs" aria-label={t("settings.sections")} {...tablistProps}>
            {TABS.map((tabId) => {
              const { onClick, ...tabProps } = getTabProps(tabId);
              return (
                <button
                  key={tabId}
                  className={`settings-tab${tab === tabId ? " active" : ""}`}
                  onClick={onClick}
                  {...tabProps}
                  autoFocus={tabId === tab}
                >
                  {t(TAB_LABELS[tabId])}
                </button>
              );
            })}
          </div>

          <div className="modal-body" {...getPanelProps(tab)}>
            <fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            {tab === "general" && settings && appSettings && (
              <GeneralTab
                workspaceName={name}
                workspaceFolder={workspaceFolder}
                onWorkspaceNameChange={setName}
                workspaceId={workspaceId}
                settings={settings}
                onChange={setSettings}
                appSettings={appSettings}
                systemAppearance={systemAppearance}
                systemLanguage={systemLanguage}
                onAppSettingsChange={setAppSettings}
              />
            )}
            {tab === "ai" && anthropic && (
              <AiTab
                draft={anthropic}
                onChange={setAnthropic}
                lastListedModels={lastListedModels.current}
              />
            )}
            {tab === "targets" && (
              <TargetsTab
                targets={targets}
                supportedLanguages={settings?.supportedLanguages ?? []}
                onChange={setTargets}
              />
            )}
            {tab === "analysis" && (
              <AnalysisPromptsTab
                prompts={prompts}
                onReset={() => setPrompts(structuredClone(analysisPromptDefaults))}
                onChange={setPrompts}
              />
            )}
            {tab === "generation" && generationPrompts && generationPromptDefaults && (
              <GenerationTab
                data={generationPrompts}
                onReset={() => setGenerationPrompts(structuredClone(generationPromptDefaults))}
                onChange={setGenerationPrompts}
              />
            )}
            </fieldset>
          </div>
          {saveError && (
            <OperationalResult severity="error" className="modal-result modal-footer-result">
              {text(saveError)}
            </OperationalResult>
          )}
          {renameSkips.length > 0 && (
            <OperationalResult severity="warning" className="modal-result modal-footer-result">
              <ListedMessageView listed={renameSkipsResult(renameSkips)} />
            </OperationalResult>
          )}
          <div className="modal-footer">
            <button
              className="btn-action"
              onClick={() => void handleRequestClose()}
              disabled={saving && !storagePending}
            >
              {saving && storagePending ? t("common.close") : t("common.cancel")}
            </button>
            <button
              className="btn-primary"
              onClick={handleSaveAll}
              disabled={!canSave}
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

// --- Shared ---

function FieldError({ msg }: { msg: Message }) {
  const { text } = useI18n();
  return <p className="settings-field-error">{text(msg)}</p>;
}

// --- General ---

/**
 * Keeps a field's text under the user's control while they are typing.
 *
 * A controlled input rendered from a PARSED model re-formats itself on every
 * keystroke: the comma you just typed is dropped by the parse and so never
 * reaches the screen — typing "fr" after "en, ja" produced "en, jafr" — and a
 * cleared number field refills from the model under the caret. The draft is
 * what the input shows; the model is still derived from it on every keystroke,
 * so validation and the Save gate see each edit as it happens.
 *
 * `stillMine` says whether the draft still represents the incoming value. It
 * re-syncs only when the model changed from OUTSIDE the field — a reload or a
 * reset — never on the user's own keystrokes.
 */
function useFieldDraft(
  persisted: string,
  stillMine: (draft: string) => boolean,
): [string, (text: string) => void] {
  const [draft, setDraft] = useState(persisted);
  useEffect(() => {
    setDraft((current) => (stillMine(current) ? current : persisted));
    // stillMine closes over this render's props, which is exactly the comparison
    // wanted: has the value arriving now diverged from what the field shows?
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persisted]);
  return [draft, setDraft];
}

/** The comma-separated language list, as the model holds it. */
function parseLanguages(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function GeneralTab({
  workspaceName,
  workspaceFolder,
  onWorkspaceNameChange,
  workspaceId,
  settings,
  onChange,
  appSettings,
  systemAppearance,
  systemLanguage,
  onAppSettingsChange,
}: {
  workspaceName: string;
  workspaceFolder: string;
  onWorkspaceNameChange: (name: string) => void;
  workspaceId: string;
  settings: Settings;
  onChange: (s: Settings) => void;
  appSettings: AppSettings;
  systemAppearance: "light" | "dark";
  systemLanguage: Language;
  onAppSettingsChange: (s: AppSettings) => void;
}) {
  const { t, locale } = useI18n();
  const fieldIds = useId();
  const update = (patch: Partial<Settings>) =>
    onChange({ ...settings, ...patch });

  // The same per-field messages the Save gate and the IPC boundary read, so a
  // message can never appear beside a value one of them would accept.
  const errors = settingsFieldErrors(settings);

  // Offered once per opening: neither list changes while Settings is open.
  const [zones] = useState(() => timeZoneOptions(settings.timezone));
  const [systemZone] = useState(systemTimeZone);

  const persistedLanguages = settings.supportedLanguages.join(", ");
  const [languagesText, setLanguagesText] = useFieldDraft(
    persistedLanguages,
    (draft) => parseLanguages(draft).join(", ") === persistedLanguages,
  );
  const [perLoadText, setPerLoadText] = useFieldDraft(
    String(settings.postsPerLoad),
    (draft) => Number(draft) === settings.postsPerLoad,
  );

  return (
    <div className="settings-section">
      <div className="form-field">
        <label className="form-label" htmlFor="settings-workspace-name">{t("settings.workspaceName")}</label>
        <input
          id="settings-workspace-name"
          className="form-input"
          value={workspaceName}
          onChange={(e) => onWorkspaceNameChange(e.target.value)}
          aria-invalid={!workspaceName.trim() || undefined}
        />
        {!workspaceName.trim() && <FieldError msg={message("settings.nameRequired")} />}
        {/* The folder is shown, never edited: a workspace stays where it is. */}
        <p className="settings-hint">{t("settings.workspaceFolder", { path: workspaceFolder })}</p>
      </div>
      {/* Chosen from the list, never typed. System follows the computer's zone
          on every launch. */}
      <div className="form-field">
        <label className="form-label" htmlFor="settings-timezone">{t("settings.timezone")}</label>
        <select
          id="settings-timezone"
          className="form-select"
          value={settings.timezone}
          onChange={(e) => update({ timezone: e.target.value })}
        >
          <option value={SYSTEM_TIME_ZONE}>{t("settings.timezoneSystem", { zone: systemZone })}</option>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor={`${fieldIds}-supportedLanguages`}>{t("settings.supportedLanguages")}</label>
        <input
          id={`${fieldIds}-supportedLanguages`}
          className="form-input"
          value={languagesText}
          onChange={(e) => {
            setLanguagesText(e.target.value);
            update({ supportedLanguages: parseLanguages(e.target.value) });
          }}
          placeholder="en, ja, es, fr, de"
        />
        {errors.supportedLanguages && <FieldError msg={errors.supportedLanguages} />}
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor={`${fieldIds}-postsPerLoad`}>{t("settings.postsPerLoad")}</label>
        <input
          id={`${fieldIds}-postsPerLoad`}
          className="form-input"
          type="number"
          value={perLoadText}
          onChange={(e) => {
            setPerLoadText(e.target.value);
            // An emptied field is NaN, which the validator calls out and the
            // Save gate refuses, rather than a fallback number the user never
            // chose appearing under the caret; and a typed 0 stays 0 for the
            // validator, which `parseInt(...) || fallback` could not tell from nothing.
            update({ postsPerLoad: Number.parseInt(e.target.value, 10) });
          }}
        />
        {errors.postsPerLoad && <FieldError msg={errors.postsPerLoad} />}
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor={`${fieldIds}-editorWatermark`}>{t("settings.editorWatermark")}</label>
        <textarea
          id={`${fieldIds}-editorWatermark`}
          className="form-input"
          rows={5}
          value={settings.editorWatermark}
          onChange={(e) => update({ editorWatermark: e.target.value })}
          style={{ resize: "vertical" }}
        />
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor={`${fieldIds}-extraFieldWatermark`}>{t("settings.extraFieldWatermark")}</label>
        <textarea
          id={`${fieldIds}-extraFieldWatermark`}
          className="form-input"
          rows={3}
          value={settings.extraFieldWatermark}
          onChange={(e) => update({ extraFieldWatermark: e.target.value })}
          style={{ resize: "vertical" }}
        />
      </div>

      <div className="settings-subheading">{t("settings.appearance")}</div>
      {/* Each language is listed by its own name, in its own script, so a
          reader of any of them can find it whatever language is showing.
          App-wide, applied on Save. */}
      <div className="form-field">
        <label className="form-label" htmlFor="settings-language">{t("settings.language")}</label>
        <select
          id="settings-language"
          className="form-select"
          value={appSettings.language}
          onChange={(e) =>
            onAppSettingsChange({ ...appSettings, language: normalizeLanguagePreference(e.target.value) })
          }
        >
          {/* System names the language it resolves to, in the interface language
              (localization conventions, Translation); the options below keep their
              own names. */}
          <option value="system">{t("settings.languageSystem", { language: languageNameIn(locale, systemLanguage) })}</option>
          {LANGUAGES.map((language) => (
            <option key={language} value={language} lang={language}>
              {LANGUAGE_NAMES[language]}
            </option>
          ))}
        </select>
        <p className="settings-hint">{t("settings.languageHint")}</p>
      </div>
      {/* A native radio group: one tab stop, arrow keys move and select
          (composite-control conventions). App-wide, applied on Save. */}
      <fieldset className="form-field settings-radio-group">
        <legend className="form-label">{t("settings.theme")}</legend>
        <div className="settings-radio-options">
          {THEME_PREFERENCES.map(({ value, label }) => (
            <label key={value} className="settings-radio">
              <input
                type="radio"
                name="theme"
                value={value}
                checked={appSettings.theme === value}
                onChange={() => onAppSettingsChange({ ...appSettings, theme: value })}
              />
              {/* System names what it resolves to now (app-chrome conventions, Theme). */}
              {value === "system"
                ? t(label, { appearance: t(systemAppearance === "dark" ? "settings.themeDark" : "settings.themeLight") })
                : t(label)}
            </label>
          ))}
        </div>
        <p className="settings-hint">{t("settings.themeHint")}</p>
      </fieldset>
      <FontsSection settings={settings} update={update} />

      <div className="settings-subheading">{t("settings.maintenance")}</div>
      <RebuildIndexSection workspaceId={workspaceId} />
    </div>
  );
}

// --- Fonts ---

function FontsSection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  const { t } = useI18n();
  const fieldIds = useId();
  const cf = settings.contentFont;
  const updateContentFont = (patch: Partial<Settings["contentFont"]>) =>
    update({ contentFont: { ...cf, ...patch } });

  // The same per-field messages the Save gate and the IPC boundary read.
  const errors = settingsFieldErrors(settings);

  const checkboxStyle = { display: "inline-flex", alignItems: "center", gap: 6 } as const;

  return (
    <>
      <div className="form-field">
        <label className="form-label" htmlFor={`${fieldIds}-uiFont`}>{t("settings.uiFont")}</label>
        <input
          id={`${fieldIds}-uiFont`}
          className="form-input"
          value={settings.uiFontFamily}
          onChange={(e) => update({ uiFontFamily: e.target.value })}
          placeholder={t("settings.uiFontPlaceholder")}
        />
        <p className="settings-hint">{t("settings.uiFontHint")}</p>
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor={`${fieldIds}-editorFont`}>{t("settings.editorFont")}</label>
        <input
          id={`${fieldIds}-editorFont`}
          className="form-input"
          value={cf.family}
          onChange={(e) => updateContentFont({ family: e.target.value })}
          placeholder={t("settings.editorFontPlaceholder")}
        />
      </div>
      <div className="form-row">
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label" htmlFor={`${fieldIds}-editorFontSize`}>{t("settings.editorFontSize")}</label>
          <input
            id={`${fieldIds}-editorFontSize`}
            className="form-input"
            type="number"
            min={CONTENT_FONT_SIZE_MIN}
            max={CONTENT_FONT_SIZE_MAX}
            value={cf.size}
            onChange={(e) => updateContentFont({ size: parseInt(e.target.value) || cf.size })}
          />
          {errors["contentFont.size"] && <FieldError msg={errors["contentFont.size"]} />}
        </div>
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label" htmlFor={`${fieldIds}-lineHeight`}>{t("settings.lineHeight")}</label>
          <input
            id={`${fieldIds}-lineHeight`}
            className="form-input"
            type="number"
            min={CONTENT_LINE_HEIGHT_MIN}
            max={CONTENT_LINE_HEIGHT_MAX}
            step={0.1}
            value={cf.lineHeight}
            onChange={(e) => updateContentFont({ lineHeight: parseFloat(e.target.value) || cf.lineHeight })}
          />
          {errors["contentFont.lineHeight"] && (
            <FieldError msg={errors["contentFont.lineHeight"]} />
          )}
        </div>
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label" htmlFor={`${fieldIds}-editorPadding`}>{t("settings.editorPadding")}</label>
          <input
            id={`${fieldIds}-editorPadding`}
            className="form-input"
            type="number"
            min={CONTENT_PADDING_MIN}
            max={CONTENT_PADDING_MAX}
            value={cf.padding}
            onChange={(e) => {
              const next = parseInt(e.target.value);
              updateContentFont({ padding: Number.isNaN(next) ? cf.padding : next });
            }}
          />
          {errors["contentFont.padding"] && <FieldError msg={errors["contentFont.padding"]} />}
        </div>
      </div>
      <div className="form-field">
        <div className="form-label" id={`${fieldIds}-text-style`}>{t("settings.editorTextStyle")}</div>
        <div role="group" aria-labelledby={`${fieldIds}-text-style`} style={{ display: "flex", gap: 16 }}>
          <label style={checkboxStyle}>
            <input type="checkbox" checked={cf.bold} onChange={(e) => updateContentFont({ bold: e.target.checked })} />
            {t("settings.bold")}
          </label>
          <label style={checkboxStyle}>
            <input type="checkbox" checked={cf.italic} onChange={(e) => updateContentFont({ italic: e.target.checked })} />
            {t("settings.italic")}
          </label>
          <label style={checkboxStyle}>
            <input
              type="checkbox"
              checked={cf.underline}
              onChange={(e) => updateContentFont({ underline: e.target.checked })}
            />
            {t("settings.underline")}
          </label>
        </div>
      </div>
    </>
  );
}

// --- Maintenance ---

// What a rebuild found: the counts, rendered as sentences when shown.
type RebuildSummary = { count: number; skipped: number; duplicateSlugs: number; orphanedAssets: number };

function RebuildIndexSection({ workspaceId }: { workspaceId: string }) {
  const { t, text, rich } = useI18n();
  const storagePending = useStoragePending();
  const reportStorageResult = useStorageResultReporter();
  const current = useRef(true);
  const runningRef = useRef(false);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<RebuildSummary | null>(null);
  const [error, setError] = useState<Message | null>(null);

  const rebuild = async () => {
    if (runningRef.current || storagePending) return;
    runningRef.current = true;
    setRunning(true);
    setSummary(null);
    setError(null);
    try {
      const { count, skipped, duplicateSlugs, orphanedAssets } = await rebuildPostIndex(workspaceId);
      if (current.current) setSummary({ count, skipped, duplicateSlugs, orphanedAssets });
      else {
        if (skipped > 0) reportStorageResult(message("settings.rebuildSkipped", { count: skipped }), "warning");
        if (duplicateSlugs > 0) reportStorageResult(message("settings.rebuildDuplicates", { count: duplicateSlugs }), "warning");
        if (orphanedAssets > 0) reportStorageResult(message("settings.rebuildOrphans", { count: orphanedAssets }), "warning");
      }
    } catch (err) {
      const failure = presentFailure(message("settings.rebuildFailed"), "renderer: post index rebuild failed", err);
      if (current.current) setError(failure);
      else reportStorageResult(failure);
    } finally {
      runningRef.current = false;
      if (current.current) setRunning(false);
    }
  };

  return (
    <div className="form-field">
      <p className="settings-hint">
        {rich("settings.rebuildHint", { file: <code>posts/index.json</code> })}
      </p>
      <button className="btn-action" onClick={() => void rebuild()} disabled={running || storagePending}>
        {running ? t("settings.rebuilding") : t("settings.rebuild")}
      </button>
      {summary && (
        <p className="settings-hint">
          {t("settings.rebuilt", { count: summary.count })}
          {/* A skipped file is a post the app can no longer show. Saying only
              what was indexed let one vanish under a success message. */}
          {summary.skipped > 0 && <> {t("settings.rebuildSkipped", { count: summary.skipped })}</>}
          {summary.duplicateSlugs > 0 && <> {t("settings.rebuildDuplicates", { count: summary.duplicateSlugs })}</>}
          {/* Asset folders whose post is gone: nothing here deletes them (they
              are the user's uploads, and a .md can be restored from git), but
              nothing in the UI could reach them either, so the count is the
              path to them. */}
          {summary.orphanedAssets > 0 && <> {t("settings.rebuildOrphans", { count: summary.orphanedAssets })}</>}
        </p>
      )}
      {error && (
        <OperationalResult severity="error" className="modal-result">
          {text(error)}
        </OperationalResult>
      )}
    </div>
  );
}

// --- AI ---

const ROLE_LABELS: Record<AiRole, MessageKey> = {
  analysis: "settings.modelAnalysis",
  metadata: "settings.modelMetadata",
  imagingPrompts: "settings.modelImagingPrompts",
};

const ROLE_HINTS: Record<AiRole, MessageKey> = {
  analysis: "settings.modelAnalysisHint",
  metadata: "settings.modelMetadataHint",
  imagingPrompts: "settings.modelImagingPromptsHint",
};

/**
 * One role's model field: free-typed, with a warning line when the id has no row
 * in SUPPORTED_MODELS, and beside it the role's Thinking field when the row lists
 * more than one value (ai-model-routing-conventions). An edit that reaches a
 * different listed row than the last one the field held resets the Thinking field
 * to that row's default.
 */
function ModelField({ role, model, thinking, lastListedModels, onChange }: {
  role: AiRole;
  model: string;
  thinking: string;
  lastListedModels: Partial<Record<AiRole, string>>;
  onChange: (model: string, thinking: string) => void;
}) {
  const { t } = useI18n();
  const row = rowFor(model);
  const modelId = `settings-model-${role}`;
  const thinkingId = `settings-thinking-${role}`;
  return (
    <div className="form-row">
      <div className="form-field" style={{ flex: 2 }}>
        <label className="form-label" htmlFor={modelId}>{t(ROLE_LABELS[role])}</label>
        <input
          id={modelId}
          className="form-input"
          spellCheck={false}
          value={model}
          onChange={(e) => {
            const edit = thinkingAfterModelEdit(lastListedModels[role] ?? model, e.target.value, thinking);
            lastListedModels[role] = edit.lastListedModel;
            onChange(e.target.value, edit.thinking);
          }}
        />
        <p className="settings-hint">{t(ROLE_HINTS[role])}</p>
        {!model.trim() ? (
          <FieldError msg={message("settings.modelRequired")} />
        ) : !row ? (
          <p className="settings-hint-warning">{t("settings.modelUnsupported")}</p>
        ) : null}
      </div>
      {hasThinkingChoice(row) && (
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label" htmlFor={thinkingId}>{t("settings.thinking")}</label>
          <select
            id={thinkingId}
            className="form-select"
            value={thinking}
            onChange={(e) => onChange(model, e.target.value)}
          >
            {row.thinking.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function AiTab({
  draft,
  onChange,
  lastListedModels,
}: {
  draft: AnthropicDraft;
  onChange: (d: AnthropicDraft) => void;
  lastListedModels: Partial<Record<AiRole, string>>;
}) {
  const { t } = useI18n();
  const setRole = (role: AiRole, model: string, thinking: string) =>
    onChange({
      ...draft,
      models: { ...draft.models, [role]: model },
      thinking: { ...draft.thinking, [role]: thinking },
    });

  return (
    <div className="settings-section">
      <div className="settings-subheading">{PROVIDER_LABELS.anthropic}</div>
      <p className="settings-hint">{t("settings.onlyProvider", { provider: PROVIDER_LABELS.anthropic })}</p>
      <div className="form-field">
        <label className="form-label" htmlFor="settings-endpoint">{t("settings.endpoint")}</label>
        <input
          id="settings-endpoint"
          className="form-input"
          spellCheck={false}
          value={draft.endpoint}
          onChange={(e) => onChange({ ...draft, endpoint: e.target.value })}
        />
        <p className="settings-hint">{t("settings.endpointHint", { provider: PROVIDER_LABELS.anthropic })}</p>
        {!isEndpoint(draft.endpoint) && <FieldError msg={message("settings.endpointInvalid")} />}
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor="settings-api-key">{t("settings.apiKey")}</label>
        <input
          id="settings-api-key"
          className="form-input"
          type="password"
          value={draft.apiKey}
          onChange={(e) => onChange({ ...draft, apiKey: e.target.value })}
          placeholder={draft.hasApiKey ? t("settings.apiKeyKeep") : t("settings.apiKeyOptional")}
        />
        {draft.usingEnvKey && (
          <p className="settings-hint">{t("settings.envKey", { variable: "ANTHROPIC_API_KEY" })}</p>
        )}
        {draft.keyNotice && <FieldError msg={draft.keyNotice} />}
      </div>
      {AI_ROLE_IDS.map((role) => (
        <ModelField
          key={role}
          role={role}
          model={draft.models[role]}
          thinking={draft.thinking[role]}
          lastListedModels={lastListedModels}
          onChange={(model, thinking) => setRole(role, model, thinking)}
        />
      ))}
    </div>
  );
}

// --- Targets ---

function TargetsTab({
  targets,
  supportedLanguages,
  onChange,
}: {
  targets: EditableTarget[];
  supportedLanguages: string[];
  onChange: (t: EditableTarget[]) => void;
}) {
  const { t } = useI18n();
  const fieldIds = useId();
  const canAddTarget = supportedLanguages.length > 0;

  const addTarget = () => {
    if (!canAddTarget) return;
    const defaultLang = supportedLanguages.includes("en")
      ? "en"
      : supportedLanguages[0];
    onChange([
      ...targets,
      { rowId: nanoid(), name: "", defaultLanguage: defaultLang, requiresMetadata: false },
    ]);
  };

  const updateTarget = (index: number, patch: Partial<Target>) => {
    const updated = targets.map((t, i) =>
      i === index ? { ...t, ...patch } : t
    );
    onChange(updated);
  };

  const deleteTarget = (index: number) => {
    onChange(targets.filter((_, i) => i !== index));
  };

  const duplicateNames = duplicateConfigNames(targets);
  return (
    <div className="settings-section">
      {!canAddTarget && (
        <FieldError msg={message("settings.targetsNeedLanguage")} />
      )}
      {targets.map((target, i) => (
        <div key={target.rowId} className="settings-list-item">
          <div className="form-field">
            <label className="form-label" htmlFor={`${fieldIds}-${target.rowId}-name`}>{t("workspaces.name")}</label>
              <input
                id={`${fieldIds}-${target.rowId}-name`}
                className="form-input"
                value={target.name}
                onChange={(e) => updateTarget(i, { name: e.target.value })}
              />
            {!target.name.trim() && <FieldError msg={message("settings.nameRequired")} />}
            {target.name.trim() && duplicateNames.has(target.name.trim()) && <FieldError msg={message("settings.targetNameTaken")} />}
          </div>
          <div className="form-row">
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label" htmlFor={`${fieldIds}-${target.rowId}-language`}>{t("newPost.language")}</label>
              <select
                id={`${fieldIds}-${target.rowId}-language`}
                className="form-select"
                value={target.defaultLanguage}
                onChange={(e) =>
                  updateTarget(i, { defaultLanguage: e.target.value })
                }
              >
                {supportedLanguages.map((lang) => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
                {!supportedLanguages.includes(target.defaultLanguage) && (
                  <option value={target.defaultLanguage}>{target.defaultLanguage}</option>
                )}
              </select>
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label" htmlFor={`${fieldIds}-${target.rowId}-requiresMetadata`}>{t("settings.requiresMetadata")}</label>
              <select
                id={`${fieldIds}-${target.rowId}-requiresMetadata`}
                className="form-select"
                value={target.requiresMetadata ? "yes" : "no"}
                onChange={(e) =>
                  updateTarget(i, {
                    requiresMetadata: e.target.value === "yes",
                  })
                }
              >
                <option value="yes">{t("common.yes")}</option>
                <option value="no">{t("common.no")}</option>
              </select>
            </div>
          </div>
          <button
            className="btn-toolbar btn-delete"
            onClick={() => deleteTarget(i)}
          >
            {t("common.delete")}
          </button>
        </div>
      ))}

      <button className="btn-action" onClick={addTarget} disabled={!canAddTarget}>
        {t("settings.addTarget")}
      </button>
    </div>
  );
}

// --- Generation ---

function GenerationTab({
  data,
  onReset,
  onChange,
}: {
  data: GenerationPromptsData;
  onReset: () => void;
  onChange: (d: GenerationPromptsData) => void;
}) {
  const { t } = useI18n();
  const fieldIds = useId();
  const updatePrompt = (key: string, value: string) => {
    onChange({ ...data, prompts: { ...data.prompts, [key]: value } });
  };

  return (
    <div className="generation-tab">
      <p className="settings-hint">{t("settings.generationHint")}</p>

      <div className="metadata-generate-all-row">
        <button className="btn-action" onClick={onReset}>
          {t("settings.resetGeneration")}
        </button>
      </div>

      {GENERATION_PROMPT_KEYS.map((key) => {
        const current = data.prompts?.[key] ?? "";
        return (
          <div key={key} className="form-field">
            <label className="form-label" htmlFor={`${fieldIds}-${key}`}>{t(GENERATION_PROMPT_LABELS[key]!)}</label>
            <textarea
              className="form-input"
              rows={6}
              id={`${fieldIds}-${key}`}
              value={current}
              onChange={(e) => updatePrompt(key, e.target.value)}
              style={{ resize: "vertical", fontFamily: "var(--bm-font-mono)", fontSize: 12 }}
            />
          </div>
        );
      })}
    </div>
  );
}

// --- Prompts ---

function AnalysisPromptsTab({
  prompts,
  onReset,
  onChange,
}: {
  prompts: AnalysisPrompt[];
  onReset: () => void;
  onChange: (p: AnalysisPrompt[]) => void;
}) {
  const { t, rich } = useI18n();
  const fieldIds = useId();
  const duplicateNames = duplicateConfigNames(prompts);
  const addPrompt = () => {
    onChange([...prompts, { name: "", text: "" }]);
  };

  const updatePrompt = (index: number, patch: Partial<AnalysisPrompt>) => {
    const updated = prompts.map((p, i) =>
      i === index ? { ...p, ...patch } : p
    );
    onChange(updated);
  };

  const deletePrompt = (index: number) => {
    onChange(prompts.filter((_, i) => i !== index));
  };

  return (
    <div className="settings-section">
      <p className="settings-hint">{rich("settings.analysisHint", { placeholder: "{content}" })}</p>
      <div className="metadata-generate-all-row">
        <button className="btn-action" onClick={onReset}>
          {t("settings.resetAnalysis")}
        </button>
      </div>
      {prompts.map((p, i) => (
        <div key={i} className="settings-list-item">
          <div className="form-field">
            <label className="form-label" htmlFor={`${fieldIds}-${i}-name`}>{t("workspaces.name")}</label>
              <input
                className="form-input"
                id={`${fieldIds}-${i}-name`}
                value={p.name}
                onChange={(e) => updatePrompt(i, { name: e.target.value })}
              />
            {!p.name.trim() && <FieldError msg={message("settings.nameRequired")} />}
            {p.name.trim() && duplicateNames.has(p.name.trim()) && <FieldError msg={message("settings.analysisPromptNameTaken")} />}
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor={`${fieldIds}-${i}-text`}>{rich("settings.promptText", { placeholder: "{content}" })}</label>
            <textarea
              className="form-input"
              rows={6}
              id={`${fieldIds}-${i}-text`}
              value={p.text}
              onChange={(e) => updatePrompt(i, { text: e.target.value })}
              style={{ resize: "vertical", fontFamily: "var(--bm-font-mono)", fontSize: 12 }}
            />
            {!p.text.trim() && <FieldError msg={message("settings.promptTextRequired")} />}
          </div>
          <button
            className="btn-toolbar btn-delete"
            onClick={() => deletePrompt(i)}
          >
            {t("common.delete")}
          </button>
        </div>
      ))}

      <button className="btn-action" onClick={addPrompt}>
        {t("settings.addPrompt")}
      </button>
    </div>
  );
}
