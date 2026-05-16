import { useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { Settings, Target, AnalysisPrompt, AiConfig, AiConfigsData, GenerationPromptsData } from "../types";
import { AI_PROVIDERS } from "../types";
import {
  fetchSettings,
  saveSettings,
  fetchTargets,
  saveTargets,
  fetchAnalysisPrompts,
  fetchAnalysisPromptDefaults,
  saveAnalysisPrompts,
  fetchAiConfigs,
  saveAiConfigs,
  fetchGenerationPrompts,
  fetchGenerationPromptDefaults,
  saveGenerationPrompts,
} from "../api";
import {
  GENERATION_PROMPT_KEYS,
  GENERATION_PROMPT_LABELS,
} from "../generationPromptDefaults";
import { ConfirmModal } from "./ConfirmModal";
import { ModalShell } from "./ModalShell";

interface SettingsModalProps {
  onClose: () => void;
  onSettingsChanged: () => void;
}

type Tab = "general" | "targets" | "providers" | "analysis" | "generation";

const TAB_LABELS: Record<Tab, string> = {
  general: "General",
  targets: "Targets",
  providers: "AI Configs",
  analysis: "Analysis",
  generation: "Generation",
};

export function SettingsModal({
  onClose,
  onSettingsChanged,
}: SettingsModalProps) {
  const [tab, setTab] = useState<Tab>("general");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [aiConfigs, setAiConfigs] = useState<AiConfigsData | null>(null);
  const [generationPrompts, setGenerationPrompts] = useState<GenerationPromptsData | null>(null);
  const [generationPromptDefaults, setGenerationPromptDefaults] = useState<GenerationPromptsData | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [prompts, setPrompts] = useState<AnalysisPrompt[]>([]);
  const [analysisPromptDefaults, setAnalysisPromptDefaults] = useState<AnalysisPrompt[]>([]);
  const [saving, setSaving] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  // Snapshot of server-loaded values, used for dirty detection.
  const initialSettings = useRef<Settings | null>(null);
  const initialAiConfigs = useRef<AiConfigsData | null>(null);
  const initialGenerationPrompts = useRef<GenerationPromptsData | null>(null);
  const initialTargets = useRef<Target[]>([]);
  const initialPrompts = useRef<AnalysisPrompt[]>([]);

  useEffect(() => {
    fetchSettings().then((d) => { setSettings(d); initialSettings.current = d; }).catch(() => {});
    fetchAiConfigs().then((d) => { setAiConfigs(d); initialAiConfigs.current = d; }).catch(() => {});
    fetchGenerationPromptDefaults().then((d) => setGenerationPromptDefaults(d)).catch(() => {});
    fetchGenerationPrompts().then((d) => { setGenerationPrompts(d); initialGenerationPrompts.current = d; }).catch(() => {});
    fetchTargets().then((d) => { setTargets(d); initialTargets.current = d; }).catch(() => {});
    fetchAnalysisPromptDefaults().then((d) => setAnalysisPromptDefaults(d)).catch(() => {});
    fetchAnalysisPrompts().then((d) => { setPrompts(d); initialPrompts.current = d; }).catch(() => {});
  }, []);

  const isDirty =
    JSON.stringify(settings) !== JSON.stringify(initialSettings.current) ||
    JSON.stringify(aiConfigs) !== JSON.stringify(initialAiConfigs.current) ||
    JSON.stringify(generationPrompts) !== JSON.stringify(initialGenerationPrompts.current) ||
    JSON.stringify(targets) !== JSON.stringify(initialTargets.current) ||
    JSON.stringify(prompts) !== JSON.stringify(initialPrompts.current);

  const handleRequestClose = () => {
    // If the discard-confirm is already open, do nothing — its own Escape
    // handler will close it.
    if (showDiscardConfirm) return;
    if (!isDirty) { onClose(); return; }
    setShowDiscardConfirm(true);
  };

  const isValid = (): boolean => {
    if (!settings) return false;
    if (!Number.isInteger(settings.publishedPostsPerLoad) || settings.publishedPostsPerLoad < 1) return false;
    if (!Number.isInteger(settings.maxUploadMb) || settings.maxUploadMb < 1) return false;
    const langs = settings.supportedLanguages;
    if (langs.length === 0 || langs.some((l) => !/^[a-z]{2}$/.test(l)) || new Set(langs).size !== langs.length) return false;
    if (!settings.timezone.trim()) return false;
    try { Intl.DateTimeFormat(undefined, { timeZone: settings.timezone }); } catch { return false; }
    if (aiConfigs?.configs.some((c) => !c.name.trim() || !c.model.trim())) return false;
    const tNames = targets.map((t) => t.name.trim());
    if (tNames.some((n) => !n) || new Set(tNames).size !== tNames.length) return false;
    if (prompts.some((p) => !p.name.trim() || !p.text.trim())) return false;
    return true;
  };

  const canSave = !saving && isValid();

  const handleSaveAll = async () => {
    if (!settings || !aiConfigs || !generationPrompts) return;
    setSaving(true);
    try {
      const [, savedAiConfigs, savedGenPrompts, savedTargets, savedPrompts] = await Promise.all([
        saveSettings(settings),
        saveAiConfigs(aiConfigs),
        saveGenerationPrompts(generationPrompts),
        saveTargets(targets),
        saveAnalysisPrompts(prompts),
      ]);
      setAiConfigs(savedAiConfigs);
      setGenerationPrompts(savedGenPrompts);
      setTargets(savedTargets);
      setPrompts(savedPrompts);
      onSettingsChanged();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <ModalShell
        title="Settings"
        onClose={handleRequestClose}
        width={560}
        maxHeight="85vh"
      >

        <div className="settings-tabs">
          {(["general", "targets", "providers", "analysis", "generation"] as Tab[]).map((t) => (
            <button
              key={t}
              className={`settings-tab${tab === t ? " active" : ""}`}
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === "general" && settings && (
            <GeneralTab
              settings={settings}
              onChange={setSettings}
            />
          )}
          {tab === "providers" && aiConfigs && (
            <AiTab
              aiConfigs={aiConfigs}
              onChange={setAiConfigs}
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
              defaults={analysisPromptDefaults}
              onChange={setPrompts}
            />
          )}
          {tab === "generation" && generationPrompts && generationPromptDefaults && (
            <GenerationTab
              data={generationPrompts}
              defaults={generationPromptDefaults}
              onChange={setGenerationPrompts}
            />
          )}
        </div>
        <div className="modal-footer">
          <button
            className="btn-primary"
            style={{ width: "auto" }}
            onClick={handleSaveAll}
            disabled={!canSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </ModalShell>
      {showDiscardConfirm && (
        <ConfirmModal
          title="Discard Changes"
          message="You have unsaved changes. Discard them and close?"
          confirmLabel="Discard"
          cancelLabel="Keep Editing"
          onConfirm={onClose}
          onCancel={() => setShowDiscardConfirm(false)}
        />
      )}
    </>
  );
}

// --- Shared ---

function FieldError({ msg }: { msg: string }) {
  return <p className="settings-field-error">{msg}</p>;
}

// --- General ---

function GeneralTab({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const update = (patch: Partial<Settings>) =>
    onChange({ ...settings, ...patch });

  let timezoneError = "";
  if (!settings.timezone.trim()) {
    timezoneError = "Timezone is required.";
  } else {
    try { Intl.DateTimeFormat(undefined, { timeZone: settings.timezone }); }
    catch { timezoneError = `"${settings.timezone}" is not a valid IANA timezone.`; }
  }

  const langs = settings.supportedLanguages;
  let langsError = "";
  if (langs.length === 0) langsError = "At least one language is required.";
  else if (langs.some((l) => !/^[a-z]{2}$/.test(l))) langsError = "Each language must be a 2-letter lowercase code (e.g. en, ja).";
  else if (new Set(langs).size !== langs.length) langsError = "Languages must not contain duplicates.";

  const pplInvalid = !Number.isInteger(settings.publishedPostsPerLoad) || settings.publishedPostsPerLoad < 1;
  const mbInvalid = !Number.isInteger(settings.maxUploadMb) || settings.maxUploadMb < 1;

  return (
    <div className="settings-section">
      <div className="form-field">
        <label className="form-label">Timezone (IANA)</label>
        <input
          className="form-input"
          value={settings.timezone}
          onChange={(e) => update({ timezone: e.target.value })}
          autoFocus
        />
        {timezoneError && <FieldError msg={timezoneError} />}
      </div>
      <div className="form-field">
        <label className="form-label">Supported languages</label>
        <input
          className="form-input"
          value={settings.supportedLanguages.join(", ")}
          onChange={(e) =>
            update({
              supportedLanguages: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="en, ja, es, fr, de"
        />
        {langsError && <FieldError msg={langsError} />}
      </div>
      <div className="form-field">
        <label className="form-label">Published posts per load</label>
        <input
          className="form-input"
          type="number"
          value={settings.publishedPostsPerLoad}
          onChange={(e) =>
            update({ publishedPostsPerLoad: parseInt(e.target.value) || 50 })
          }
        />
        {pplInvalid && <FieldError msg="Must be a positive integer." />}
      </div>
      <div className="form-field">
        <label className="form-label">Max upload size (MB)</label>
        <input
          className="form-input"
          type="number"
          value={settings.maxUploadMb}
          onChange={(e) =>
            update({ maxUploadMb: parseInt(e.target.value) || 500 })
          }
        />
        {mbInvalid && <FieldError msg="Must be a positive integer." />}
      </div>
      <div className="form-field">
        <label className="form-label">Editor watermark</label>
        <textarea
          className="form-input"
          rows={3}
          value={settings.editorWatermark}
          onChange={(e) => update({ editorWatermark: e.target.value })}
          style={{ resize: "vertical" }}
        />
      </div>
      <div className="form-field">
        <label className="form-label">Extra field watermark</label>
        <textarea
          className="form-input"
          rows={2}
          value={settings.extraFieldWatermark}
          onChange={(e) => update({ extraFieldWatermark: e.target.value })}
          style={{ resize: "vertical" }}
        />
      </div>

    </div>
  );
}

// --- AI ---

function AiTab({
  aiConfigs,
  onChange,
}: {
  aiConfigs: AiConfigsData;
  onChange: (d: AiConfigsData) => void;
}) {
  const updateConfig = (id: string, patch: Partial<AiConfig>) =>
    onChange({
      ...aiConfigs,
      configs: aiConfigs.configs.map((c) =>
        c.id === id ? { ...c, ...patch } : c
      ),
    });

  const addConfig = () => {
    const id = nanoid();
    onChange({
      ...aiConfigs,
      configs: [
        ...aiConfigs.configs,
        { id, name: "", provider: "claude", apiKey: "", hasApiKey: false, model: "claude-sonnet-4-6" },
      ],
    });
  };

  const deleteConfig = (id: string) => {
    const remaining = aiConfigs.configs.filter((c) => c.id !== id);
    onChange({
      configs: remaining,
      activeId:
        aiConfigs.activeId === id
          ? (remaining[0]?.id ?? "")
          : aiConfigs.activeId,
    });
  };

  return (
    <div className="settings-section">
      <div className="form-field">
        <label className="form-label">Active AI config</label>
        <select
          className="form-select"
          value={aiConfigs.activeId}
          onChange={(e) =>
            onChange({ ...aiConfigs, activeId: e.target.value })
          }
          autoFocus
        >
          {aiConfigs.configs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || "(unnamed)"}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-subheading">AI Configs</div>

      {aiConfigs.configs.map((c) => (
        <div key={c.id} className="settings-list-item">
          <div className="form-field">
            <label className="form-label">Name</label>
            <input
              className="form-input"
              value={c.name}
              onChange={(e) => updateConfig(c.id, { name: e.target.value })}
            />
            {!c.name.trim() && <FieldError msg="Name is required." />}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">Provider</label>
              <select
                className="form-select"
                value={c.provider}
                onChange={(e) =>
                  updateConfig(c.id, {
                    provider: e.target.value as AiConfig["provider"],
                  })
                }
              >
                {AI_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ flex: 2 }}>
              <label className="form-label">Model</label>
              <input
                className="form-input"
                value={c.model}
                onChange={(e) => updateConfig(c.id, { model: e.target.value })}
              />
              {!c.model.trim() && <FieldError msg="Model is required." />}
            </div>
          </div>
          <div className="form-field">
            <label className="form-label">API Key</label>
            <input
              className="form-input"
              type="password"
              value={c.apiKey}
              onChange={(e) => updateConfig(c.id, { apiKey: e.target.value })}
              placeholder={c.hasApiKey ? "Leave blank to keep the current key" : "Optional"}
            />
            <p className="settings-hint">
              {c.apiKey.trim()
                ? "Will be saved when you click Save."
                : c.hasApiKey
                  ? "Leave blank to keep the current key."
                  : "Optional."}
            </p>
          </div>
          <button
            className="btn-toolbar btn-delete"
            onClick={() => deleteConfig(c.id)}
            disabled={aiConfigs.configs.length === 1}
          >
            Delete
          </button>
        </div>
      ))}

      <button className="btn-toolbar" onClick={addConfig}>
        + Add AI Config
      </button>
    </div>
  );
}

// --- Targets ---

function TargetsTab({
  targets,
  supportedLanguages,
  onChange,
}: {
  targets: Target[];
  supportedLanguages: string[];
  onChange: (t: Target[]) => void;
}) {
  const canAddTarget = supportedLanguages.length > 0;

  const addTarget = () => {
    if (!canAddTarget) return;
    const defaultLang = supportedLanguages.includes("en")
      ? "en"
      : supportedLanguages[0];
    onChange([
      ...targets,
      { name: "", defaultLanguage: defaultLang, requiresMetadata: false },
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
        <FieldError msg="Add at least one supported language in General before creating targets." />
      )}
      {targets.map((t, i) => (
        <div key={i} className="settings-list-item">
          <div className="form-field">
            <label className="form-label">Name</label>
              <input
                className="form-input"
                value={t.name}
                onChange={(e) => updateTarget(i, { name: e.target.value })}
                autoFocus={i === 0}
              />
            {!t.name.trim() && <FieldError msg="Name is required." />}
            {t.name.trim() && duplicateNames.has(t.name.trim()) && <FieldError msg="This name is already used by another target." />}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">Language</label>
              <select
                className="form-select"
                value={t.defaultLanguage}
                onChange={(e) =>
                  updateTarget(i, { defaultLanguage: e.target.value })
                }
              >
                {supportedLanguages.map((lang) => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
                {!supportedLanguages.includes(t.defaultLanguage) && (
                  <option value={t.defaultLanguage}>{t.defaultLanguage}</option>
                )}
              </select>
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">Requires metadata</label>
              <select
                className="form-select"
                value={t.requiresMetadata ? "yes" : "no"}
                onChange={(e) =>
                  updateTarget(i, {
                    requiresMetadata: e.target.value === "yes",
                  })
                }
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
          </div>
          <button
            className="btn-toolbar btn-delete"
            onClick={() => deleteTarget(i)}
          >
            Delete
          </button>
        </div>
      ))}

      <button className="btn-toolbar" onClick={addTarget} disabled={!canAddTarget} autoFocus={targets.length === 0}>
        + Add Target
      </button>
    </div>
  );
}

// --- Generation ---

function GenerationTab({
  data,
  defaults,
  onChange,
}: {
  data: GenerationPromptsData;
  defaults: GenerationPromptsData;
  onChange: (d: GenerationPromptsData) => void;
}) {
  const updatePrompt = (key: string, value: string) => {
    onChange({ ...data, prompts: { ...data.prompts, [key]: value } });
  };

  const restoreAll = () => {
    onChange({
      prompts: { ...defaults.prompts },
    });
  };

  return (
    <div className="generation-tab">
      <p className="settings-hint">
        Field guidance is inserted into a structured metadata request. The app controls the JSON schema and draft content automatically.
      </p>

      <div className="metadata-generate-all-row">
        <button className="btn-toolbar" onClick={restoreAll}>
          Restore built-in prompts
        </button>
      </div>

      {GENERATION_PROMPT_KEYS.map((key, index) => {
        const current = data.prompts?.[key] ?? "";
        return (
          <div key={key} className="form-field">
            <label className="form-label">{GENERATION_PROMPT_LABELS[key]}</label>
            <textarea
              className="form-input"
              rows={3}
              value={current}
              onChange={(e) => updatePrompt(key, e.target.value)}
              style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
              autoFocus={index === 0}
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
  defaults,
  onChange,
}: {
  prompts: AnalysisPrompt[];
  defaults: AnalysisPrompt[];
  onChange: (p: AnalysisPrompt[]) => void;
}) {
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
      <div className="metadata-generate-all-row">
        <button
          className="btn-toolbar"
          onClick={() => onChange(defaults.map((prompt) => ({ ...prompt })))}
        >
          Restore built-in prompts
        </button>
      </div>
      {prompts.map((p, i) => (
        <div key={i} className="settings-list-item">
          <div className="form-field">
            <label className="form-label">Name</label>
              <input
                className="form-input"
                value={p.name}
                onChange={(e) => updatePrompt(i, { name: e.target.value })}
                autoFocus={i === 0}
              />
            {!p.name.trim() && <FieldError msg="Name is required." />}
          </div>
          <div className="form-field">
            <label className="form-label">
              Prompt text ({"{content}"} = post content)
            </label>
            <textarea
              className="form-input"
              rows={6}
              value={p.text}
              onChange={(e) => updatePrompt(i, { text: e.target.value })}
              style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
            />
            {!p.text.trim() && <FieldError msg="Prompt text is required." />}
          </div>
          <button
            className="btn-toolbar btn-delete"
            onClick={() => deletePrompt(i)}
          >
            Delete
          </button>
        </div>
      ))}

      <button className="btn-toolbar" onClick={addPrompt} autoFocus={prompts.length === 0}>
        + Add Prompt
      </button>
    </div>
  );
}
