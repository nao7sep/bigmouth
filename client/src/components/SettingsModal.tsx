import { useEffect, useState } from "react";
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

interface SettingsModalProps {
  onClose: () => void;
  onSettingsChanged: () => void;
}

type Tab = "general" | "targets" | "ai" | "prompts";

const TAB_LABELS: Record<Tab, string> = {
  general: "General",
  targets: "Targets",
  ai: "AI",
  prompts: "Prompts",
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

  const handleSaveSettings = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await saveSettings(settings);
      onSettingsChanged();
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTargets = async () => {
    setSaving(true);
    try {
      const saved = await saveTargets(targets);
      setTargets(saved);
      onSettingsChanged();
    } finally {
      setSaving(false);
    }
  };

  const handleSavePrompts = async () => {
    setSaving(true);
    try {
      const saved = await savePrompts(prompts);
      setPrompts(saved);
      onSettingsChanged();
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
          {(["general", "targets", "ai", "prompts"] as Tab[]).map((t) => (
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
              onSave={handleSaveSettings}
              saving={saving}
            />
          )}
          {tab === "ai" && settings && (
            <AiTab
              settings={settings}
              onChange={setSettings}
              onSave={handleSaveSettings}
              saving={saving}
            />
          )}
          {tab === "targets" && (
            <TargetsTab
              targets={targets}
              supportedLanguages={settings?.supportedLanguages ?? []}
              onChange={setTargets}
              onSave={handleSaveTargets}
              saving={saving}
            />
          )}
          {tab === "prompts" && (
            <PromptsTab
              prompts={prompts}
              onChange={setPrompts}
              onSave={handleSavePrompts}
              saving={saving}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// --- General ---

function GeneralTab({
  settings,
  onChange,
  onSave,
  saving,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onSave: () => void;
  saving: boolean;
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

      <div className="settings-actions">
        <button
          className="btn-new-post"
          style={{ width: "auto" }}
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

// --- AI ---

function AiTab({
  settings,
  onChange,
  onSave,
  saving,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const updateConfig = (id: string, patch: Partial<AiConfig>) =>
    onChange({
      ...settings,
      aiConfigs: settings.aiConfigs.map((c) =>
        c.id === id ? { ...c, ...patch } : c
      ),
    });

  const addConfig = () => {
    const id = crypto.randomUUID();
    onChange({
      ...settings,
      aiConfigs: [
        ...settings.aiConfigs,
        { id, name: "", provider: "claude", apiKey: "", model: "" },
      ],
    });
  };

  const removeConfig = (id: string) => {
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
            className="btn-remove"
            onClick={() => removeConfig(c.id)}
            disabled={settings.aiConfigs.length === 1}
          >
            Remove
          </button>
        </div>
      ))}

      <button className="btn-toolbar" onClick={addConfig}>
        + Add Configuration
      </button>

      <div className="settings-actions">
        <button
          className="btn-new-post"
          style={{ width: "auto" }}
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

// --- Targets ---

function TargetsTab({
  targets,
  supportedLanguages,
  onChange,
  onSave,
  saving,
}: {
  targets: Target[];
  supportedLanguages: string[];
  onChange: (t: Target[]) => void;
  onSave: () => void;
  saving: boolean;
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

  const removeTarget = (index: number) => {
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
            className="btn-remove"
            onClick={() => removeTarget(i)}
          >
            Remove
          </button>
        </div>
      ))}

      <button className="btn-toolbar" onClick={addTarget}>
        + Add Target
      </button>

      <div className="settings-actions">
        <button
          className="btn-new-post"
          style={{ width: "auto" }}
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

// --- Prompts ---

function PromptsTab({
  prompts,
  onChange,
  onSave,
  saving,
}: {
  prompts: Prompt[];
  onChange: (p: Prompt[]) => void;
  onSave: () => void;
  saving: boolean;
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

  const removePrompt = (index: number) => {
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
            className="btn-remove"
            onClick={() => removePrompt(i)}
          >
            Remove
          </button>
        </div>
      ))}

      <button className="btn-toolbar" onClick={addPrompt}>
        + Add Prompt
      </button>

      <div className="settings-actions">
        <button
          className="btn-new-post"
          style={{ width: "auto" }}
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
