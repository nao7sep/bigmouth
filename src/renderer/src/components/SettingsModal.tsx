import { useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { AppSettings, Settings, Target, AnalysisPrompt, AnthropicSettingsView, GenerationPromptsData } from "@shared/types";
import { AI_ROLE_IDS, PROVIDER_LABELS, hasThinkingChoice, rowFor, thinkingAfterModelEdit, type AiRole } from "@shared/aiModels";
import { isEndpoint } from "@shared/configSets";
import { THEME_PREFERENCES } from "@shared/appSettings";
import { SYSTEM_TIME_ZONE, systemTimeZone, timeZoneOptions } from "@shared/timeZone";
import { LANGUAGE_NAMES, LANGUAGES, normalizeLanguagePreference } from "@shared/i18n/languages";
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

interface SettingsModalProps {
  onClose: () => void;
  onSettingsChanged: () => void;
}

/** A post file a target rename could not read, with the target it still names. */
type RenameSkip = { fileName: string; reason: string; oldName: string };

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
  onClose,
  onSettingsChanged,
}: SettingsModalProps) {
  const { t, text, rich } = useI18n();
  const [tab, setTab] = useState<Tab>("general");
  const [settings, setSettings] = useState<Settings | null>(null);
  // App-wide (the storage root's config.json), edited and saved with the
  // workspace's own settings so the theme applies on Save like everything else.
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
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
      getSettings(),
      getAnthropicSettings(),
      getGenerationPromptDefaults(),
      getGenerationPrompts(),
      listTargets(),
      listAnalysisPromptDefaults(),
      listAnalysisPrompts(),
    ])
      .then(([app, s, ai, genDefaults, gen, tgts, analysisDefaults, analysisPrompts]) => {
        if (cancelled) return;
        setAppSettings(app.settings);
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
  }, []);

  const appSettingsDirty =
    JSON.stringify(appSettings) !== JSON.stringify(initialAppSettings.current);
  const settingsDirty = JSON.stringify(settings) !== JSON.stringify(initialSettings.current);
  const generationDirty = JSON.stringify(generationPrompts) !== JSON.stringify(initialGenerationPrompts.current);
  const analysisDirty = JSON.stringify(prompts) !== JSON.stringify(initialPrompts.current);
  const targetsDirty = JSON.stringify(targetPayload(targets)) !== JSON.stringify(targetPayload(initialTargets.current));
  const anthropicDirty = JSON.stringify(anthropic) !== JSON.stringify(initialAnthropic.current);
  const isDirty =
    appSettingsDirty || settingsDirty || generationDirty || analysisDirty || targetsDirty || anthropicDirty;

  const handleRequestClose = async () => {
    if (saving) return; // non-interruptible save in progress; gate every close path (incl. Escape)
    if (!isDirty) { onClose(); return; }
    const ok = await confirm({
      title: t("settings.discardTitle"),
      message: t("settings.discardMessage"),
      confirmLabel: t("common.discard"),
      cancelLabel: t("common.keepEditing"),
      danger: true,
    });
    if (ok) onClose();
  };

  const isValid = (): boolean => {
    if (!settings) return false;
    // The settings fields answer from the one module the inputs render their
    // messages from, so an inline error can never sit beside an enabled Save.
    if (firstSettingsError(settings) !== null) return false;
    if (anthropic && (!isEndpoint(anthropic.endpoint) || AI_ROLE_IDS.some((role) => !anthropic.models[role].trim()))) {
      return false;
    }
    const tNames = targets.map((t) => t.name.trim());
    if (tNames.some((n) => !n) || new Set(tNames).size !== tNames.length) return false;
    if (prompts.some((p) => !p.name.trim() || !p.text.trim())) return false;
    return true;
  };

  // Save requires both dirty and valid: re-persisting an unchanged form is a
  // no-op that the convention asks us to disable.
  const canSave = !saving && isDirty && isValid();

  const { tablistProps, getTabProps, getPanelProps } = useTablist<Tab>({
    tabs: TABS,
    selected: tab,
    onSelect: setTab,
    idBase: "settings",
  });

  const handleSaveAll = async () => {
    if (!appSettings || !settings || !anthropic || !generationPrompts) return;
    setSaving(true);
    setSaveError(null);
    setRenameSkips([]);
    try {
      const renames = targets
        .map((target) => ({
          oldName: target.originalName?.trim() ?? "",
          newName: target.name.trim(),
        }))
        .filter(({ oldName, newName }) => oldName && newName && oldName !== newName);

      const { endpoint, models, thinking, apiKey } = anthropic;
      const [savedAppSettings, savedSettings, savedAnthropic, savedGenPrompts, savedPrompts] = await Promise.all([
        appSettingsDirty ? saveAppSettings(appSettings) : Promise.resolve(appSettings),
        settingsDirty ? saveSettings(settings) : Promise.resolve(settings),
        anthropicDirty
          ? saveAnthropicSettings({ endpoint, models, thinking, ...(apiKey.trim() ? { apiKey } : {}) })
          : Promise.resolve(anthropic),
        generationDirty ? saveGenerationPrompts(generationPrompts) : Promise.resolve(generationPrompts),
        analysisDirty ? saveAnalysisPrompts(prompts) : Promise.resolve(prompts),
      ]);

      const skips: RenameSkip[] = [];
      for (const { oldName, newName } of renames) {
        const { postsSkipped } = await renameTarget(oldName, newName);
        for (const file of postsSkipped) skips.push({ ...file, oldName });
      }
      const savedTargets = targetsDirty ? await saveTargets(targetPayload(targets)) : targetPayload(targets);

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
      onSettingsChanged();
      if (skips.length > 0) setRenameSkips(skips);
      else onClose();
    } catch (err) {
      setSaveError(presentFailure(
        message("settings.saveFailed"),
        "renderer: settings save failed",
        err,
      ));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      title={t("settings.title")}
      onClose={() => void handleRequestClose()}
      width={560}
      maxHeight="85vh"
      closeDisabled={saving}
    >
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
            {tab === "general" && settings && appSettings && (
              <GeneralTab
                settings={settings}
                onChange={setSettings}
                appSettings={appSettings}
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
          </div>
          {saveError && (
            <OperationalResult severity="error" className="modal-result modal-footer-result">
              {text(saveError)}
            </OperationalResult>
          )}
          {renameSkips.length > 0 && (
            <OperationalResult severity="warning" className="modal-result modal-footer-result">
              {t("settings.renameSkipped", { count: renameSkips.length })}
              <ul className="modal-result-list">
                {renameSkips.map((skip) => (
                  <li key={`${skip.oldName}/${skip.fileName}`}>
                    {rich("settings.renameSkippedFile", {
                      file: <code>{skip.fileName}</code>,
                      target: skip.oldName,
                      reason: skip.reason,
                    })}
                  </li>
                ))}
              </ul>
            </OperationalResult>
          )}
          <div className="modal-footer">
            <button
              className="btn-action"
              onClick={() => void handleRequestClose()}
              disabled={saving}
            >
              {t("common.cancel")}
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
  settings,
  onChange,
  appSettings,
  onAppSettingsChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  appSettings: AppSettings;
  onAppSettingsChange: (s: AppSettings) => void;
}) {
  const { t } = useI18n();
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
  const [maxUploadText, setMaxUploadText] = useFieldDraft(
    String(settings.maxUploadMb),
    (draft) => Number(draft) === settings.maxUploadMb,
  );

  return (
    <div className="settings-section">
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
        <label className="form-label">{t("settings.supportedLanguages")}</label>
        <input
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
        <label className="form-label">{t("settings.postsPerLoad")}</label>
        <input
          className="form-input"
          type="number"
          value={perLoadText}
          onChange={(e) => {
            setPerLoadText(e.target.value);
            // An emptied field is NaN, which the validator calls out and the
            // Save gate refuses. It used to become 50 — a magic number the user
            // never chose, applied under the caret — and a typed 0 became 50 too,
            // because `parseInt(...) || 50` cannot tell zero from nothing.
            update({ postsPerLoad: Number.parseInt(e.target.value, 10) });
          }}
        />
        {errors.postsPerLoad && <FieldError msg={errors.postsPerLoad} />}
      </div>
      <div className="form-field">
        <label className="form-label">{t("settings.maxAssetSize")}</label>
        <input
          className="form-input"
          type="number"
          value={maxUploadText}
          onChange={(e) => {
            setMaxUploadText(e.target.value);
            update({ maxUploadMb: Number.parseInt(e.target.value, 10) });
          }}
        />
        {errors.maxUploadMb && <FieldError msg={errors.maxUploadMb} />}
      </div>
      <div className="form-field">
        <label className="form-label">{t("settings.editorWatermark")}</label>
        <textarea
          className="form-input"
          rows={5}
          value={settings.editorWatermark}
          onChange={(e) => update({ editorWatermark: e.target.value })}
          style={{ resize: "vertical" }}
        />
      </div>
      <div className="form-field">
        <label className="form-label">{t("settings.extraFieldWatermark")}</label>
        <textarea
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
          <option value="system">{t("settings.languageSystem")}</option>
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
              {t(label)}
            </label>
          ))}
        </div>
        <p className="settings-hint">{t("settings.themeHint")}</p>
      </fieldset>
      <FontsSection settings={settings} update={update} />

      <div className="settings-subheading">{t("settings.maintenance")}</div>
      <RebuildIndexSection />
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
  const cf = settings.contentFont;
  const updateContentFont = (patch: Partial<Settings["contentFont"]>) =>
    update({ contentFont: { ...cf, ...patch } });

  // The same per-field messages the Save gate and the IPC boundary read.
  const errors = settingsFieldErrors(settings);

  const checkboxStyle = { display: "inline-flex", alignItems: "center", gap: 6 } as const;

  return (
    <>
      <div className="form-field">
        <label className="form-label">{t("settings.uiFont")}</label>
        <input
          className="form-input"
          value={settings.uiFontFamily}
          onChange={(e) => update({ uiFontFamily: e.target.value })}
          placeholder={t("settings.uiFontPlaceholder")}
        />
        <p className="settings-hint">{t("settings.uiFontHint")}</p>
      </div>
      <div className="form-field">
        <label className="form-label">{t("settings.editorFont")}</label>
        <input
          className="form-input"
          value={cf.family}
          onChange={(e) => updateContentFont({ family: e.target.value })}
          placeholder={t("settings.editorFontPlaceholder")}
        />
      </div>
      <div className="form-row">
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label">{t("settings.editorFontSize")}</label>
          <input
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
          <label className="form-label">{t("settings.lineHeight")}</label>
          <input
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
          <label className="form-label">{t("settings.editorPadding")}</label>
          <input
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
        <label className="form-label">{t("settings.editorTextStyle")}</label>
        <div style={{ display: "flex", gap: 16 }}>
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

function RebuildIndexSection() {
  const { t, text, rich } = useI18n();
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<RebuildSummary | null>(null);
  const [error, setError] = useState<Message | null>(null);

  const rebuild = async () => {
    setRunning(true);
    setSummary(null);
    setError(null);
    try {
      const { count, skipped, duplicateSlugs, orphanedAssets } = await rebuildPostIndex();
      setSummary({ count, skipped, duplicateSlugs, orphanedAssets });
    } catch (err) {
      setError(presentFailure(
        message("settings.rebuildFailed"),
        "renderer: post index rebuild failed",
        err,
      ));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="form-field">
      <p className="settings-hint">
        {rich("settings.rebuildHint", { file: <code>posts/index.json</code> })}
      </p>
      <button className="btn-action" onClick={() => void rebuild()} disabled={running}>
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

  const trimmedNames = targets.map((t) => t.name.trim());
  const duplicateNames = new Set(
    trimmedNames.filter((n, i) => n && trimmedNames.indexOf(n) !== i)
  );
  return (
    <div className="settings-section">
      {!canAddTarget && (
        <FieldError msg={message("settings.targetsNeedLanguage")} />
      )}
      {targets.map((target, i) => (
        <div key={target.rowId} className="settings-list-item">
          <div className="form-field">
            <label className="form-label">{t("workspaces.name")}</label>
              <input
                className="form-input"
                value={target.name}
                onChange={(e) => updateTarget(i, { name: e.target.value })}
              />
            {!target.name.trim() && <FieldError msg={message("settings.nameRequired")} />}
            {target.name.trim() && duplicateNames.has(target.name.trim()) && <FieldError msg={message("settings.targetNameTaken")} />}
          </div>
          <div className="form-row">
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">{t("newPost.language")}</label>
              <select
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
              <label className="form-label">{t("settings.requiresMetadata")}</label>
              <select
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
            <label className="form-label">{t(GENERATION_PROMPT_LABELS[key]!)}</label>
            <textarea
              className="form-input"
              rows={6}
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
            <label className="form-label">{t("workspaces.name")}</label>
              <input
                className="form-input"
                value={p.name}
                onChange={(e) => updatePrompt(i, { name: e.target.value })}
              />
            {!p.name.trim() && <FieldError msg={message("settings.nameRequired")} />}
          </div>
          <div className="form-field">
            <label className="form-label">{rich("settings.promptText", { placeholder: "{content}" })}</label>
            <textarea
              className="form-input"
              rows={6}
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
