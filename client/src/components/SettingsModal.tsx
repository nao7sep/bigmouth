import { useEffect, useState } from "react";
import { nanoid } from "nanoid";
import type { Settings, Target, Prompt, AiConfig } from "../types";
import { AI_PROVIDERS } from "../types";
import {
  fetchSettings,
  saveSettings,
  fetchTargets,
  saveTargets,
  fetchPrompts,
  savePrompts,
} from "../api";
import {
  DEFAULT_GENERATION_PROMPTS,
  DEFAULT_GENERATION_PREAMBLE,
  GENERATION_PROMPT_LABELS,
} from "../generationPromptDefaults";

interface SettingsModalProps {
  onClose: () => void;
  onSettingsChanged: () => void;
}

type Tab = "general" | "targets" | "providers" | "analysis" | "generation";

const TAB_LABELS: Record<Tab, string> = {
  general: "General",
  targets: "Targets",
  providers: "Providers",
  analysis: "Analysis",
  generation: "Generation",
};

export function SettingsModal({
  onClose,
  onSettingsChanged,
}: SettingsModalProps) {
  const [tab, setTab] = useState<Tab>("general");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings().then(setSettings).catch(() => {});
    fetchTargets().then(setTargets).catch(() => {});
    fetchPrompts().then(setPrompts).catch(() => {});
  }, []);

  const isValid = (): boolean => {
    if (!settings) return false;

    // General
    const port = settings.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;

    const ppl = settings.publishedPostsPerLoad;
    if (!Number.isInteger(ppl) || ppl < 1) return false;

    const langs = settings.supportedLanguages;
    if (langs.length === 0) return false;
    if (langs.some((l) => !/^[a-z]{2}$/.test(l))) return false;
    if (new Set(langs).size !== langs.length) return false;

    if (!settings.timezone.trim()) return false;
    try {
      Intl.DateTimeFormat(undefined, { timeZone: settings.timezone });
    } catch {
      return false;
    }

    // AI configs
    if (settings.aiConfigs.some((c) => !c.name.trim() || !c.model.trim())) return false;

    // Targets
    if (targets.some((t) => !t.name.trim())) return false;
    const targetNames = targets.map((t) => t.name.trim());
    if (new Set(targetNames).size !== targetNames.length) return false;

    // Prompts
    if (prompts.some((p) => !p.name.trim() || !p.text.trim())) return false;

    return true;
  };

  const canSave = !saving && isValid();

  const handleSaveAll = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const [, savedTargets, savedPrompts] = await Promise.all([
        saveSettings(settings),
        saveTargets(targets),
        savePrompts(prompts),
      ]);
      setTargets(savedTargets);
      setPrompts(savedPrompts);
      onSettingsChanged();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        style={{ width: 560, maxHeight: "85vh" }}
      >
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

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
          {tab === "providers" && settings && (
            <AiTab
              settings={settings}
              onChange={setSettings}
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
            <PromptsTab
              prompts={prompts}
              onChange={setPrompts}
            />
          )}
          {tab === "generation" && settings && (
            <GenerationTab
              settings={settings}
              onChange={setSettings}
            />
          )}
        </div>
        <div className="modal-footer">
          <button
            className="btn-new-post"
            style={{ width: "auto" }}
            onClick={handleSaveAll}
            disabled={!canSave}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
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

  return (
    <div className="settings-section">
      <div className="form-field">
        <label className="form-label">Port</label>
        <input
          className="form-input"
          type="number"
          value={settings.port}
          onChange={(e) =>
            update({ port: parseInt(e.target.value) || 3141 })
          }
        />
      </div>
      <div className="form-field">
        <label className="form-label">Timezone (IANA)</label>
        <input
          className="form-input"
          value={settings.timezone}
          onChange={(e) => update({ timezone: e.target.value })}
        />
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
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const updateConfig = (id: string, patch: Partial<AiConfig>) =>
    onChange({
      ...settings,
      aiConfigs: settings.aiConfigs.map((c) =>
        c.id === id ? { ...c, ...patch } : c
      ),
    });

  const addConfig = () => {
    const id = nanoid();
    onChange({
      ...settings,
      aiConfigs: [
        ...settings.aiConfigs,
        { id, name: "", provider: "claude", apiKey: "", model: "" },
      ],
    });
  };

  const deleteConfig = (id: string) => {
    const remaining = settings.aiConfigs.filter((c) => c.id !== id);
    onChange({
      ...settings,
      aiConfigs: remaining,
      activeAiConfigId:
        settings.activeAiConfigId === id
          ? (remaining[0]?.id ?? "")
          : settings.activeAiConfigId,
    });
  };

  return (
    <div className="settings-section">
      <div className="form-field">
        <label className="form-label">Active configuration</label>
        <select
          className="form-select"
          value={settings.activeAiConfigId}
          onChange={(e) =>
            onChange({ ...settings, activeAiConfigId: e.target.value })
          }
        >
          {settings.aiConfigs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || "(unnamed)"}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-subheading">Configurations</div>

      {settings.aiConfigs.map((c) => (
        <div key={c.id} className="settings-list-item">
          <div className="form-field">
            <label className="form-label">Name</label>
            <input
              className="form-input"
              value={c.name}
              onChange={(e) => updateConfig(c.id, { name: e.target.value })}
            />
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
            </div>
          </div>
          <div className="form-field">
            <label className="form-label">API Key</label>
            <input
              className="form-input"
              type="password"
              value={c.apiKey}
              onChange={(e) => updateConfig(c.id, { apiKey: e.target.value })}
              placeholder="Enter API key"
            />
          </div>
          <button
            className="btn-toolbar btn-delete"
            onClick={() => deleteConfig(c.id)}
            disabled={settings.aiConfigs.length === 1}
          >
            Delete
          </button>
        </div>
      ))}

      <button className="btn-toolbar" onClick={addConfig}>
        + Add Configuration
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
  const addTarget = () => {
    const defaultLang = supportedLanguages.includes("en")
      ? "en"
      : (supportedLanguages[0] ?? "en");
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

  return (
    <div className="settings-section">
      {targets.map((t, i) => (
        <div key={i} className="settings-list-item">
          <div className="form-field">
            <label className="form-label">Name</label>
            <input
              className="form-input"
              value={t.name}
              onChange={(e) => updateTarget(i, { name: e.target.value })}
            />
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

      <button className="btn-toolbar" onClick={addTarget}>
        + Add Target
      </button>
    </div>
  );
}

// --- Generation ---

function GenerationTab({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const currentPreamble = settings.generationPreamble ?? DEFAULT_GENERATION_PREAMBLE;
  const isPreambleDefault = currentPreamble === DEFAULT_GENERATION_PREAMBLE;

  const updatePreamble = (value: string) => {
    onChange({ ...settings, generationPreamble: value });
  };

  const updatePrompt = (key: string, value: string) => {
    onChange({
      ...settings,
      generationPrompts: { ...settings.generationPrompts, [key]: value },
    });
  };

  const resetPrompt = (key: string) => {
    onChange({
      ...settings,
      generationPrompts: {
        ...settings.generationPrompts,
        [key]: DEFAULT_GENERATION_PROMPTS[key],
      },
    });
  };

  return (
    <div className="settings-section">
      <p className="settings-hint">
        System prompts used when generating metadata fields with AI. The post content is passed as the user message.
      </p>

      <div className="settings-list-item">
        <div className="form-field">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <label className="form-label">Preamble</label>
            {!isPreambleDefault && (
              <button
                className="btn-toolbar"
                style={{ fontSize: 11, padding: "2px 8px" }}
                onClick={() => updatePreamble(DEFAULT_GENERATION_PREAMBLE)}
              >
                Reset to default
              </button>
            )}
          </div>
          <textarea
            className="form-input"
            rows={4}
            value={currentPreamble}
            onChange={(e) => updatePreamble(e.target.value)}
            style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
          />
        </div>
      </div>

      {Object.keys(DEFAULT_GENERATION_PROMPTS).map((key) => {
        const current = settings.generationPrompts?.[key] ?? DEFAULT_GENERATION_PROMPTS[key];
        const isDefault = current === DEFAULT_GENERATION_PROMPTS[key];
        return (
          <div key={key} className="settings-list-item">
            <div className="form-field">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <label className="form-label">{GENERATION_PROMPT_LABELS[key]}</label>
                {!isDefault && (
                  <button
                    className="btn-toolbar"
                    style={{ fontSize: 11, padding: "2px 8px" }}
                    onClick={() => resetPrompt(key)}
                  >
                    Reset to default
                  </button>
                )}
              </div>
              <textarea
                className="form-input"
                rows={3}
                value={current}
                onChange={(e) => updatePrompt(key, e.target.value)}
                style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Prompts ---

function PromptsTab({
  prompts,
  onChange,
}: {
  prompts: Prompt[];
  onChange: (p: Prompt[]) => void;
}) {
  const addPrompt = () => {
    onChange([...prompts, { name: "", text: "" }]);
  };

  const updatePrompt = (index: number, patch: Partial<Prompt>) => {
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
      {prompts.map((p, i) => (
        <div key={i} className="settings-list-item">
          <div className="form-field">
            <label className="form-label">Name</label>
            <input
              className="form-input"
              value={p.name}
              onChange={(e) => updatePrompt(i, { name: e.target.value })}
            />
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
          </div>
          <button
            className="btn-toolbar btn-delete"
            onClick={() => deletePrompt(i)}
          >
            Delete
          </button>
        </div>
      ))}

      <button className="btn-toolbar" onClick={addPrompt}>
        + Add Prompt
      </button>
    </div>
  );
}
