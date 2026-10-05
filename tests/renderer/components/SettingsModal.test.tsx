import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent, within } from "@testing-library/react";
import type {
  Settings,
  Target,
  AnalysisPrompt,
  AnthropicSettingsView,
  GenerationPromptsData,
} from "@shared/types";
import { DEFAULT_CONTENT_FONT } from "@shared/types";
import { settingsFieldErrors } from "@shared/settingsValidation";

// SettingsModal reaches the main process only through these api functions; mock
// the whole module so the dialog renders against in-memory fixtures.
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
  getAppSettings: vi.fn(),
  saveAppSettings: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  listTargets: vi.fn(),
  saveTargets: vi.fn(),
  renameTarget: vi.fn(),
  listAnalysisPrompts: vi.fn(),
  listAnalysisPromptDefaults: vi.fn(),
  saveAnalysisPrompts: vi.fn(),
  getAnthropicSettings: vi.fn(),
  saveAnthropicSettings: vi.fn(),
  getGenerationPrompts: vi.fn(),
  getGenerationPromptDefaults: vi.fn(),
  saveGenerationPrompts: vi.fn(),
  rebuildPostIndex: vi.fn(),
}));

import { SettingsModal } from "@renderer/components/SettingsModal";
import { ConfirmProvider } from "@renderer/components/ConfirmHost";
import * as api from "@renderer/api";

const mock = {
  getAppSettings: vi.mocked(api.getAppSettings),
  saveAppSettings: vi.mocked(api.saveAppSettings),
  getSettings: vi.mocked(api.getSettings),
  saveSettings: vi.mocked(api.saveSettings),
  listTargets: vi.mocked(api.listTargets),
  saveTargets: vi.mocked(api.saveTargets),
  renameTarget: vi.mocked(api.renameTarget),
  listAnalysisPrompts: vi.mocked(api.listAnalysisPrompts),
  listAnalysisPromptDefaults: vi.mocked(api.listAnalysisPromptDefaults),
  saveAnalysisPrompts: vi.mocked(api.saveAnalysisPrompts),
  getAnthropicSettings: vi.mocked(api.getAnthropicSettings),
  saveAnthropicSettings: vi.mocked(api.saveAnthropicSettings),
  getGenerationPrompts: vi.mocked(api.getGenerationPrompts),
  getGenerationPromptDefaults: vi.mocked(api.getGenerationPromptDefaults),
  saveGenerationPrompts: vi.mocked(api.saveGenerationPrompts),
};

function settings(): Settings {
  return {
    timezone: "UTC",
    supportedLanguages: ["en", "ja"],
    postsPerLoad: 50,
    maxUploadMb: 500,
    editorWatermark: "",
    extraFieldWatermark: "",
    uiFontFamily: "",
    contentFont: { ...DEFAULT_CONTENT_FONT },
  };
}

function targets(): Target[] {
  return [{ name: "blog", defaultLanguage: "en", requiresMetadata: false }];
}

function prompts(): AnalysisPrompt[] {
  return [{ name: "Review", text: "Analyze {content}" }];
}

function genPrompts(): GenerationPromptsData {
  return { prompts: { title: "" } };
}

function anthropic(overrides?: Partial<AnthropicSettingsView>): AnthropicSettingsView {
  return {
    endpoint: "https://api.anthropic.com",
    models: { analysis: "claude-sonnet-5-5", metadata: "claude-haiku-4-5", imagingPrompts: "claude-sonnet-5-5" },
    thinking: { analysis: "adaptive", metadata: "off", imagingPrompts: "adaptive" },
    hasApiKey: false,
    usingEnvKey: false,
    ...overrides,
  };
}

// Seed every loader so the modal's all-or-nothing Promise.all resolves and the
// editor renders. `ai` lets a test vary just the AI fixture.
function seedLoaders(ai: AnthropicSettingsView = anthropic()) {
  mock.getAppSettings.mockResolvedValue({ settings: { theme: "system", language: "system" }, notice: null });
  mock.saveAppSettings.mockImplementation((next) => Promise.resolve({ theme: "system", language: "system", ...next }));
  mock.getSettings.mockResolvedValue(settings());
  mock.getAnthropicSettings.mockResolvedValue(ai);
  mock.getGenerationPromptDefaults.mockResolvedValue(genPrompts());
  mock.getGenerationPrompts.mockResolvedValue(genPrompts());
  mock.listTargets.mockResolvedValue(targets());
  mock.listAnalysisPromptDefaults.mockResolvedValue(prompts());
  mock.listAnalysisPrompts.mockResolvedValue(prompts());
}

async function renderModal(ai?: AnthropicSettingsView) {
  seedLoaders(ai);
  const onClose = vi.fn();
  const onSettingsChanged = vi.fn();
  const utils = render(
    <ConfirmProvider>
      <SettingsModal onClose={onClose} onSettingsChanged={onSettingsChanged} />
    </ConfirmProvider>,
  );
  // Flush the loader Promise.all so the tabs + body render.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { onClose, onSettingsChanged, ...utils };
}

// Switch to the AI tab and return its panel for scoped queries.
function openAiTab(getByRole: ReturnType<typeof render>["getByRole"]) {
  fireEvent.click(getByRole("tab", { name: "AI" }));
  return getByRole("tabpanel");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("SettingsModal — render and tab switching", () => {
  it("shows a loading state until the resources resolve", async () => {
    seedLoaders();
    const { getByText } = render(
      <ConfirmProvider>
        <SettingsModal onClose={vi.fn()} onSettingsChanged={vi.fn()} />
      </ConfirmProvider>,
    );
    expect(getByText("Loading…")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getByText("General")).toBeTruthy();
  });

  it("surfaces a load error and gates the editor", async () => {
    mock.getSettings.mockRejectedValue(new Error("disk gone"));
    mock.getAnthropicSettings.mockResolvedValue(anthropic());
    mock.getGenerationPromptDefaults.mockResolvedValue(genPrompts());
    mock.getGenerationPrompts.mockResolvedValue(genPrompts());
    mock.listTargets.mockResolvedValue(targets());
    mock.listAnalysisPromptDefaults.mockResolvedValue(prompts());
    mock.listAnalysisPrompts.mockResolvedValue(prompts());

    const { getByText, getByRole, queryByRole } = render(
      <ConfirmProvider>
        <SettingsModal onClose={vi.fn()} onSettingsChanged={vi.fn()} />
      </ConfirmProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getByText("Settings could not be loaded. Close and reopen Settings to try again.")).toBeTruthy();
    expect(getByRole("alert").textContent).not.toContain("Error:");
    // No tablist is rendered while the load failed.
    expect(queryByRole("tablist")).toBeNull();
  });

  it("renders all five tabs and switches the visible panel", async () => {
    const { getByRole, getByText } = await renderModal();
    for (const label of ["General", "Targets", "AI", "Analysis", "Generation"]) {
      expect(getByRole("tab", { name: label })).toBeTruthy();
    }
    // General is the default panel.
    expect(getByText("Time zone")).toBeTruthy();

    // Switch to AI.
    const panel = openAiTab(getByRole);
    expect(within(panel).getByText("Anthropic is the only AI provider BigMouth supports.")).toBeTruthy();
  });
});

describe("SettingsModal — AI tab key hints/placeholders", () => {
  it("shows the env-key hint when usingEnvKey is set", async () => {
    const { getByRole } = await renderModal(anthropic({ usingEnvKey: true }));
    const panel = openAiTab(getByRole);
    expect(
      within(panel).getByText("Using ANTHROPIC_API_KEY; it overrides any stored key."),
    ).toBeTruthy();
  });

  it("uses the keep-current placeholder when a key is already stored", async () => {
    const { getByRole } = await renderModal(anthropic({ hasApiKey: true }));
    const panel = openAiTab(getByRole);
    expect(within(panel).getByPlaceholderText("Leave blank to keep current key")).toBeTruthy();
  });

  it("uses the Optional placeholder when no key is stored and no env key is present", async () => {
    const { getByRole } = await renderModal();
    const panel = openAiTab(getByRole);
    expect(within(panel).getByPlaceholderText("Optional")).toBeTruthy();
    expect(
      within(panel).queryByText("Using ANTHROPIC_API_KEY; it overrides any stored key."),
    ).toBeNull();
  });
});

describe("SettingsModal — AI tab model fields", () => {
  it("shows one Anthropic section with Endpoint, API key and a model field per role, and no Provider control", async () => {
    const { getByRole } = await renderModal();
    const panel = openAiTab(getByRole);
    expect(within(panel).getByText("Anthropic")).toBeTruthy();
    expect((within(panel).getByLabelText("Endpoint") as HTMLInputElement).value).toBe("https://api.anthropic.com");
    expect(within(panel).getByLabelText("API Key")).toBeTruthy();
    expect((within(panel).getByLabelText("Analysis model") as HTMLInputElement).value).toBe("claude-sonnet-5-5");
    expect((within(panel).getByLabelText("Metadata model") as HTMLInputElement).value).toBe("claude-haiku-4-5");
    expect((within(panel).getByLabelText("Imaging prompts model") as HTMLInputElement).value).toBe("claude-sonnet-5-5");
    expect(within(panel).queryByLabelText("Provider")).toBeNull();
    expect(within(panel).queryByText("This model is not supported and may not work as expected.")).toBeNull();
  });

  it("shows a Thinking field only for a role whose model lists more than one value, in the row's order", async () => {
    const { getByRole } = await renderModal();
    const panel = openAiTab(getByRole);
    // Sonnet (Analysis, Imaging prompts) lists seven values; Haiku (Metadata) lists only off.
    const fields = within(panel).getAllByLabelText("Thinking") as HTMLSelectElement[];
    expect(fields).toHaveLength(2);
    expect([...fields[0]!.options].map((option) => option.value)).toEqual([
      "between_tools", "adaptive", "low", "medium", "high", "xhigh", "max",
    ]);
    expect(fields[0]!.value).toBe("adaptive");
  });

  it("warns under a model with no row and hides its Thinking field", async () => {
    const { getByRole } = await renderModal();
    const panel = openAiTab(getByRole);
    fireEvent.change(within(panel).getByLabelText("Analysis model"), { target: { value: "claude-next-9" } });
    const p = getByRole("tabpanel");
    expect(within(p).getAllByText("This model is not supported and may not work as expected.")).toHaveLength(1);
    expect(within(p).getAllByLabelText("Thinking")).toHaveLength(1);
    // Free text the store does not judge: Save stays available.
    expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("resets a role's Thinking field to the new model's default when its model changes", async () => {
    const { getByRole } = await renderModal(anthropic({ thinking: { analysis: "between_tools", metadata: "off", imagingPrompts: "adaptive" } }));
    const panel = openAiTab(getByRole);
    expect((within(panel).getAllByLabelText("Thinking")[0] as HTMLSelectElement).value).toBe("between_tools");
    fireEvent.change(within(panel).getByLabelText("Analysis model"), { target: { value: "claude-opus-5-5" } });
    const fields = within(getByRole("tabpanel")).getAllByLabelText("Thinking") as HTMLSelectElement[];
    expect(fields[0]!.value).toBe("adaptive");
    expect([...fields[0]!.options].map((option) => option.value)).not.toContain("between_tools");
  });

  it("keeps a role's Thinking choice while a model edit resolves to the same row", async () => {
    const { getByRole } = await renderModal(anthropic({ thinking: { analysis: "between_tools", metadata: "off", imagingPrompts: "adaptive" } }));
    openAiTab(getByRole);
    const analysisThinking = () => (within(getByRole("tabpanel")).getAllByLabelText("Thinking")[0] as HTMLSelectElement).value;
    for (const same of ["claude-sonnet-5-5 ", "Claude-Sonnet-5-5", "claude-sonnet-5-5"]) {
      fireEvent.change(within(getByRole("tabpanel")).getByLabelText("Analysis model"), { target: { value: same } });
      expect(analysisThinking(), same).toBe("between_tools");
    }
  });

  it("keeps a role's Thinking choice when its model passes through ids with no row, even across a tab switch", async () => {
    const { getByRole } = await renderModal(anthropic({ thinking: { analysis: "between_tools", metadata: "off", imagingPrompts: "adaptive" } }));
    openAiTab(getByRole);
    const model = () => within(getByRole("tabpanel")).getByLabelText("Analysis model");
    const analysisThinking = () => (within(getByRole("tabpanel")).getAllByLabelText("Thinking")[0] as HTMLSelectElement).value;
    fireEvent.change(model(), { target: { value: "claude-sonnet-5-" } });
    fireEvent.click(getByRole("tab", { name: "General" }));
    openAiTab(getByRole);
    fireEvent.change(model(), { target: { value: "claude-sonnet-5-5" } });
    expect(analysisThinking()).toBe("between_tools");
    // Reaching a different listed row starts at that row's default.
    fireEvent.change(model(), { target: { value: "claude-opus-5-" } });
    fireEvent.change(model(), { target: { value: "claude-opus-5-5" } });
    expect(analysisThinking()).toBe("adaptive");
  });

  it("reopened on a Thinking stored under an id with no row, keeps it at the first listed row that offers it", async () => {
    const { getByRole } = await renderModal(anthropic({
      models: { analysis: "claude-next-9", metadata: "claude-haiku-4-5", imagingPrompts: "claude-sonnet-5-5" },
      thinking: { analysis: "between_tools", metadata: "off", imagingPrompts: "adaptive" },
    }));
    openAiTab(getByRole);
    const model = () => within(getByRole("tabpanel")).getByLabelText("Analysis model");
    const analysisThinking = () => (within(getByRole("tabpanel")).getAllByLabelText("Thinking")[0] as HTMLSelectElement).value;
    expect(within(getByRole("tabpanel")).getAllByLabelText("Thinking")).toHaveLength(1);
    fireEvent.change(model(), { target: { value: "claude-sonnet-5-5" } });
    expect(analysisThinking()).toBe("between_tools");
    // Once the field has held a listed row, reaching a different one resets it.
    fireEvent.change(model(), { target: { value: "claude-opus-5-5" } });
    expect(analysisThinking()).toBe("adaptive");
  });

  it("reopened on a Thinking stored under an id with no row, takes the default of a listed row that does not offer it", async () => {
    const { getByRole } = await renderModal(anthropic({
      models: { analysis: "claude-next-9", metadata: "claude-haiku-4-5", imagingPrompts: "claude-sonnet-5-5" },
      thinking: { analysis: "between_tools", metadata: "off", imagingPrompts: "adaptive" },
    }));
    openAiTab(getByRole);
    fireEvent.change(within(getByRole("tabpanel")).getByLabelText("Analysis model"), { target: { value: "claude-opus-5-5" } });
    expect((within(getByRole("tabpanel")).getAllByLabelText("Thinking")[0] as HTMLSelectElement).value).toBe("adaptive");
  });

  it("takes the Thinking default from the chosen model's tier, not the role's, and lists that model's values", async () => {
    const { getByRole } = await renderModal();
    const thinkingFields = () => within(getByRole("tabpanel")).getAllByLabelText("Thinking") as HTMLSelectElement[];
    const options = (field: HTMLSelectElement) => [...field.options].map((option) => option.value);
    const panel = openAiTab(getByRole);
    // Metadata is a fast role on Haiku, which shows no field; Sonnet brings its own adaptive default.
    expect(thinkingFields()).toHaveLength(2);
    fireEvent.change(within(panel).getByLabelText("Metadata model"), { target: { value: "claude-sonnet-5-5" } });
    expect(thinkingFields()).toHaveLength(3);
    expect(thinkingFields()[1]!.value).toBe("adaptive");
    expect(options(thinkingFields()[1]!)).toEqual(["between_tools", "adaptive", "low", "medium", "high", "xhigh", "max"]);
    for (const model of ["claude-fable-5-1", "claude-opus-5-5"]) {
      fireEvent.change(within(getByRole("tabpanel")).getByLabelText("Metadata model"), { target: { value: model } });
      expect(thinkingFields()[1]!.value, model).toBe("adaptive");
      expect(options(thinkingFields()[1]!), model).toEqual(["adaptive", "low", "medium", "high", "xhigh", "max"]);
    }
    // Back on Haiku the field goes again.
    fireEvent.change(within(getByRole("tabpanel")).getByLabelText("Metadata model"), { target: { value: "claude-haiku-4-5" } });
    expect(thinkingFields()).toHaveLength(2);
  });

  it("gates Save on an empty model or an endpoint that is not an http(s) address", async () => {
    const { getByRole } = await renderModal();
    const panel = openAiTab(getByRole);
    const save = () => (getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled;

    fireEvent.change(within(panel).getByLabelText("Metadata model"), { target: { value: " " } });
    expect(within(getByRole("tabpanel")).getByText("Enter a model.")).toBeTruthy();
    expect(save()).toBe(true);
    fireEvent.change(within(getByRole("tabpanel")).getByLabelText("Metadata model"), { target: { value: "claude-haiku-4-5" } });
    expect(save()).toBe(true); // back to what was loaded: nothing to save

    fireEvent.change(within(getByRole("tabpanel")).getByLabelText("Endpoint"), { target: { value: "api.anthropic.com" } });
    expect(within(getByRole("tabpanel")).getByText("Enter an address starting with https:// or http://.")).toBeTruthy();
    expect(save()).toBe(true);
  });
});

describe("SettingsModal — Save flow (Anthropic section)", () => {
  it("disables Save until the form is dirty", async () => {
    const { getByRole } = await renderModal();
    const save = getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const panel = openAiTab(getByRole);
    fireEvent.change(within(panel).getByLabelText("Endpoint"), { target: { value: "https://proxy.example" } });
    expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("saves the section with each role's model and thinking, and only the edited set", async () => {
    const { getByRole, onClose, onSettingsChanged } = await renderModal();
    mock.saveAnthropicSettings.mockImplementation(async ({ endpoint, models, thinking }) => anthropic({ endpoint, models, thinking }));

    const panel = openAiTab(getByRole);
    fireEvent.change(within(panel).getByLabelText("Analysis model"), { target: { value: "claude-opus-5-5" } });
    fireEvent.change(within(getByRole("tabpanel")).getAllByLabelText("Thinking")[0]!, { target: { value: "max" } });
    fireEvent.change(within(getByRole("tabpanel")).getByLabelText("Imaging prompts model"), { target: { value: "claude-next-9" } });

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // A blank key field sends no key, so the stored one is kept.
    expect(mock.saveAnthropicSettings).toHaveBeenCalledWith({
      endpoint: "https://api.anthropic.com",
      models: { analysis: "claude-opus-5-5", metadata: "claude-haiku-4-5", imagingPrompts: "claude-next-9" },
      thinking: { analysis: "max", metadata: "off", imagingPrompts: "adaptive" },
    });
    expect(mock.saveSettings).not.toHaveBeenCalled();
    expect(mock.saveGenerationPrompts).not.toHaveBeenCalled();
    expect(mock.saveAnalysisPrompts).not.toHaveBeenCalled();
    expect(mock.saveTargets).not.toHaveBeenCalled();
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sends a key only when one was typed", async () => {
    const { getByRole } = await renderModal();
    mock.saveAnthropicSettings.mockResolvedValue(anthropic({ hasApiKey: true }));
    const panel = openAiTab(getByRole);
    fireEvent.change(within(panel).getByLabelText("API Key"), { target: { value: "sk-new" } });

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mock.saveAnthropicSettings).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-new" }));
  });

  it("surfaces a save error and keeps the modal open", async () => {
    const { getByRole, onClose, getByText } = await renderModal();
    mock.saveAnthropicSettings.mockRejectedValue(new Error("write failed"));

    const panel = openAiTab(getByRole);
    fireEvent.change(within(panel).getByLabelText("Endpoint"), { target: { value: "https://proxy.example" } });

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getByText("Settings could not be saved. Your changes are still shown; try again.")).toBeTruthy();
    expect(getByRole("alert").textContent).not.toContain("Error:");
    expect(onClose).not.toHaveBeenCalled();
  });
});

// --- Additional coverage: General / Targets / Analysis / Generation / close ---

const mockRebuildPostIndex = vi.mocked(api.rebuildPostIndex);

// Open a tab by its visible label and return its panel for scoped queries.
function openTab(
  getByRole: ReturnType<typeof render>["getByRole"],
  label: string,
): HTMLElement {
  fireEvent.click(getByRole("tab", { name: label }));
  return getByRole("tabpanel");
}

describe("SettingsModal — interface language", () => {
  it("lists System first, then each language by its own name in its own script", async () => {
    const { getByLabelText } = await renderModal();
    const picker = getByLabelText("Interface language") as HTMLSelectElement;
    expect(picker.value).toBe("system");
    const options = [...picker.options];
    expect(options.map((option) => option.value)).toEqual([
      "system", "en", "de", "es", "fr", "it", "pt-BR", "ru", "ja", "ko", "zh-Hans",
    ]);
    expect(options.map((option) => option.textContent)).toEqual([
      "System", "English", "Deutsch", "Español", "Français", "Italiano", "Português", "Русский", "日本語", "한국어", "中文",
    ]);
    expect(options[8]!.lang).toBe("ja");
  });

  it("stages the language until Save, then saves it app-wide", async () => {
    const { getByRole, getByLabelText } = await renderModal();
    fireEvent.change(getByLabelText("Interface language"), { target: { value: "ja" } });
    expect(mock.saveAppSettings).not.toHaveBeenCalled();
    mock.saveSettings.mockImplementation((next) => Promise.resolve({ ...settings(), ...next }));
    mock.saveTargets.mockResolvedValue(targets());
    mock.saveGenerationPrompts.mockResolvedValue(genPrompts());
    mock.saveAnalysisPrompts.mockResolvedValue(prompts());
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
    });
    expect(mock.saveAppSettings).toHaveBeenCalledWith({ theme: "system", language: "ja" });
  });
});

describe("SettingsModal — theme", () => {
  it("offers System, Light, and Dark as one radio group under Appearance", async () => {
    const { getByRole } = await renderModal();
    const group = getByRole("group", { name: "Theme" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(["system", "light", "dark"]);
    expect(radios.find((radio) => radio.checked)?.value).toBe("system");
  });

  it("stages the theme until Save, then saves it app-wide", async () => {
    const { getByRole, onClose } = await renderModal();
    fireEvent.click(getByRole("radio", { name: "Dark" }));
    expect(mock.saveAppSettings).not.toHaveBeenCalled();

    const save = getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    mock.saveSettings.mockImplementation((next) => Promise.resolve({ ...settings(), ...next }));
    mock.saveTargets.mockResolvedValue(targets());
    mock.saveGenerationPrompts.mockResolvedValue(genPrompts());
    mock.saveAnalysisPrompts.mockResolvedValue(prompts());
    await act(async () => {
      fireEvent.click(save);
    });

    expect(mock.saveAppSettings).toHaveBeenCalledWith({ theme: "dark", language: "system" });
    expect(onClose).toHaveBeenCalled();
  });

  it("leaves the app settings file alone when only workspace settings change", async () => {
    const { getByRole } = await renderModal();
    const watermark = getByRole("tabpanel").querySelectorAll("textarea")[0]!;
    fireEvent.change(watermark, { target: { value: "draft" } });
    mock.saveSettings.mockImplementation((next) => Promise.resolve({ ...settings(), ...next }));
    mock.saveTargets.mockResolvedValue(targets());
    mock.saveGenerationPrompts.mockResolvedValue(genPrompts());
    mock.saveAnalysisPrompts.mockResolvedValue(prompts());
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
    });

    expect(mock.saveSettings).toHaveBeenCalled();
    expect(mock.saveAppSettings).not.toHaveBeenCalled();
  });
});

describe("SettingsModal — General tab validation", () => {
  it("offers the time zone as a list that starts with System", async () => {
    const { getByRole, getByLabelText } = await renderModal();
    const tz = getByLabelText("Time zone") as HTMLSelectElement;
    expect(tz.tagName).toBe("SELECT");
    expect(tz.value).toBe("UTC");
    const options = [...tz.options];
    // The renderer project pins TZ to Asia/Tokyo, so System names that zone.
    expect(options[0]).toMatchObject({ value: "system", textContent: "System (Asia/Tokyo)" });
    expect(options.map((option) => option.value)).toContain("America/New_York");

    fireEvent.change(tz, { target: { value: "system" } });
    expect(tz.value).toBe("system");
    expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("validates the supported-languages list: empty and bad code", async () => {
    const { getByDisplayValue, getByText, queryByText } = await renderModal();
    const langs = getByDisplayValue("en, ja");

    fireEvent.change(langs, { target: { value: "" } });
    expect(getByText("At least one language is required.")).toBeTruthy();

    fireEvent.change(langs, { target: { value: "eng" } });
    expect(getByText("Each language must be a 2-letter lowercase code (e.g. en, ja).")).toBeTruthy();

    fireEvent.change(langs, { target: { value: "en, ja" } });
    expect(queryByText("Each language must be a 2-letter lowercase code (e.g. en, ja).")).toBeNull();
  });

  it("does not treat a duplicate language as an error, because the store folds it away", () => {
    // The modal used to call duplicates invalid and block Save on them, while
    // the IPC boundary accepted them and the store de-duplicated and sorted on
    // save. Commit-time cleanup is the app's answer here, so there is nothing
    // for the user to fix.
    expect(
      settingsFieldErrors({ ...settings(), supportedLanguages: ["en", "en"] }).supportedLanguages,
    ).toBeUndefined();
  });

  it("lets a language be typed in, one character at a time", async () => {
    // The field rendered supportedLanguages.join(", ") and re-parsed on every
    // keystroke, so the comma and the space were dropped before they reached the
    // screen: typing ", fr" after "en, ja" produced "en, jafr", which then failed
    // the field's own validator with no way to fix it from the keyboard.
    const { getByDisplayValue } = await renderModal();
    const langs = getByDisplayValue("en, ja") as HTMLInputElement;

    for (const next of ["en, ja,", "en, ja, ", "en, ja, f", "en, ja, fr"]) {
      fireEvent.change(langs, { target: { value: next } });
      expect(langs.value).toBe(next);
    }
  });

  it("lets a number field be cleared without refilling itself", async () => {
    const { getByRole } = await renderModal();
    const panel = getByRole("tabpanel");
    const numbers = panel.querySelectorAll('input[type="number"]');
    const perLoad = numbers[0] as HTMLInputElement;

    fireEvent.change(perLoad, { target: { value: "" } });
    // It used to snap to 50 — a value the user never chose, applied under the caret.
    expect(perLoad.value).toBe("");

    fireEvent.change(perLoad, { target: { value: "0" } });
    expect(perLoad.value).toBe("0");
  });

  it("flags a cleared numeric field rather than substituting a default", async () => {
    const { getByRole, getByText } = await renderModal();
    const panel = getByRole("tabpanel");
    const numbers = panel.querySelectorAll('input[type="number"]');

    fireEvent.change(numbers[0], { target: { value: "0" } });
    expect(getByText("Must be a positive integer.")).toBeTruthy();
    expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("flags non-positive numeric fields", async () => {
    const { getByRole, getByText } = await renderModal();
    const panel = getByRole("tabpanel");
    const numbers = panel.querySelectorAll('input[type="number"]');
    // Index 0 = published-per-load, index 1 = max upload MB. parseInt("") || 50
    // can't reach <1 via the input, so feed a value that the fallback rejects:
    // "0" parses to 0 → falsy → falls back to 50/500, so use a negative.
    fireEvent.change(numbers[0], { target: { value: "-3" } });
    expect(getByText("Must be a positive integer.")).toBeTruthy();
  });

  it("disables Save while the General form is invalid even though it is dirty", async () => {
    const { getByRole, getByDisplayValue } = await renderModal();
    // Make it dirty and invalid at once (bad timezone).
    fireEvent.change(getByDisplayValue("UTC"), { target: { value: "Not/AZone" } });
    expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("edits the editor and extra-field watermarks", async () => {
    const { getByRole } = await renderModal();
    const textareas = getByRole("tabpanel").querySelectorAll("textarea");
    fireEvent.change(textareas[0], { target: { value: "Draft watermark" } });
    fireEvent.change(textareas[1], { target: { value: "Extra watermark" } });
    expect((textareas[0] as HTMLTextAreaElement).value).toBe("Draft watermark");
    expect((textareas[1] as HTMLTextAreaElement).value).toBe("Extra watermark");
    // Editing makes the form dirty → Save becomes available.
    expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("SettingsModal — RebuildIndexSection", () => {
  it("rebuilds the index and reports the post count", async () => {
    const { getByText } = await renderModal();
    mockRebuildPostIndex.mockResolvedValue({
      count: 3,
      skipped: 0,
      duplicateSlugs: 0,
      orphanedAssets: 0,
    });

    await act(async () => {
      fireEvent.click(getByText("Rebuild index"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getByText("Rebuilt the index from 3 posts.")).toBeTruthy();
  });

  it("uses the singular noun for a one-post rebuild", async () => {
    const { getByText } = await renderModal();
    mockRebuildPostIndex.mockResolvedValue({
      count: 1,
      skipped: 0,
      duplicateSlugs: 0,
      orphanedAssets: 0,
    });
    await act(async () => {
      fireEvent.click(getByText("Rebuild index"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getByText("Rebuilt the index from 1 post.")).toBeTruthy();
  });

  it("says how many files it could not read, rather than reporting plain success", async () => {
    // A skipped file is a post the app can no longer show. Reporting only the
    // indexed count let one vanish under a success message.
    const { getByText } = await renderModal();
    mockRebuildPostIndex.mockResolvedValue({
      count: 2,
      skipped: 1,
      duplicateSlugs: 0,
      orphanedAssets: 0,
    });

    await act(async () => {
      fireEvent.click(getByText("Rebuild index"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      getByText(/Rebuilt the index from 2 posts\. 1 file could not be read and was left out/),
    ).toBeTruthy();
  });

  it("reports duplicate slug groups without claiming posts were left out", async () => {
    const { getByText } = await renderModal();
    mockRebuildPostIndex.mockResolvedValue({
      count: 2,
      skipped: 0,
      duplicateSlugs: 1,
      orphanedAssets: 0,
    });

    await act(async () => {
      fireEvent.click(getByText("Rebuild index"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      getByText(/Rebuilt the index from 2 posts\. 1 duplicate slug group remains/),
    ).toBeTruthy();
  });

  it("surfaces a rebuild failure", async () => {
    const { getByText } = await renderModal();
    mockRebuildPostIndex.mockRejectedValue(new Error("index locked"));
    await act(async () => {
      fireEvent.click(getByText("Rebuild index"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getByText("The post index could not be rebuilt. Existing posts were not changed; try again or check the log.")).toBeTruthy();
  });
});

describe("SettingsModal — Targets tab", () => {
  it("adds a target row seeded with the en default and the chosen visible fields", async () => {
    const { getByRole } = await renderModal();
    const panel = openTab(getByRole, "Targets");
    expect(within(panel).getAllByText("Name")).toHaveLength(1);

    fireEvent.click(within(panel).getByText("+ Add Target"));
    expect(within(getByRole("tabpanel")).getAllByText("Name")).toHaveLength(2);
  });

  it("flags a blank target name and a duplicate name", async () => {
    const { getByRole, getByText } = await renderModal();
    const panel = openTab(getByRole, "Targets");

    // Add a second row and give it the same name as the first ("blog").
    fireEvent.click(within(panel).getByText("+ Add Target"));
    let p = getByRole("tabpanel");
    const nameInputs = within(p).getAllByRole("textbox");
    // The new row's name starts blank → required error shows.
    expect(getByText("Name is required.")).toBeTruthy();

    // Duplicate the existing name; both colliding rows surface the error.
    fireEvent.change(nameInputs[1], { target: { value: "blog" } });
    p = getByRole("tabpanel");
    expect(
      within(p).getAllByText("This name is already used by another target."),
    ).toHaveLength(2);
  });

  it("deletes a target row", async () => {
    const { getByRole } = await renderModal();
    const panel = openTab(getByRole, "Targets");
    fireEvent.click(within(panel).getByText("+ Add Target"));
    expect(within(getByRole("tabpanel")).getAllByText("Name")).toHaveLength(2);

    const deletes = within(getByRole("tabpanel")).getAllByRole("button", { name: "Delete" });
    fireEvent.click(deletes[1]);
    expect(within(getByRole("tabpanel")).getAllByText("Name")).toHaveLength(1);
  });

  it("gates target creation when no supported languages are configured", async () => {
    // Seed settings without languages so the Targets tab disables Add.
    mock.getSettings.mockResolvedValue({ ...settings(), supportedLanguages: [] });
    mock.getAnthropicSettings.mockResolvedValue(anthropic());
    mock.getGenerationPromptDefaults.mockResolvedValue(genPrompts());
    mock.getGenerationPrompts.mockResolvedValue(genPrompts());
    mock.listTargets.mockResolvedValue(targets());
    mock.listAnalysisPromptDefaults.mockResolvedValue(prompts());
    mock.listAnalysisPrompts.mockResolvedValue(prompts());

    const { getByRole } = render(
      <ConfirmProvider>
        <SettingsModal onClose={vi.fn()} onSettingsChanged={vi.fn()} />
      </ConfirmProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const panel = openTab(getByRole, "Targets");
    expect(
      within(panel).getByText("Add at least one supported language in General before creating targets."),
    ).toBeTruthy();
    expect((within(panel).getByText("+ Add Target").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("issues a renameTarget for an in-place rename and then saves the targets", async () => {
    const { getByRole, onClose } = await renderModal();
    mock.saveSettings.mockResolvedValue(settings());
    mock.saveGenerationPrompts.mockResolvedValue(genPrompts());
    mock.saveAnalysisPrompts.mockResolvedValue(prompts());
    mock.renameTarget.mockResolvedValue({ targets: targets(), postsUpdated: 2, postsSkipped: [] });
    mock.saveTargets.mockResolvedValue([
      { name: "blog-renamed", defaultLanguage: "en", requiresMetadata: false },
    ]);

    const panel = openTab(getByRole, "Targets");
    // Rename the only existing target ("blog") in place.
    fireEvent.change(within(panel).getAllByRole("textbox")[0], { target: { value: "blog-renamed" } });

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The originalName→newName diff drives a renameTarget before saveTargets.
    expect(mock.renameTarget).toHaveBeenCalledWith("blog", "blog-renamed");
    expect(mock.saveTargets).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open after a rename and names the post files it could not read", async () => {
    const { getByRole, getByText, onClose } = await renderModal();
    mock.saveSettings.mockResolvedValue(settings());
    mock.saveGenerationPrompts.mockResolvedValue(genPrompts());
    mock.saveAnalysisPrompts.mockResolvedValue(prompts());
    mock.renameTarget.mockResolvedValue({
      targets: targets(),
      postsUpdated: 1,
      postsSkipped: [{ fileName: "20260101-000000-utc-abc.md", reason: "bad YAML" }],
    });
    mock.saveTargets.mockResolvedValue([
      { name: "blog-renamed", defaultLanguage: "en", requiresMetadata: false },
    ]);

    const panel = openTab(getByRole, "Targets");
    fireEvent.change(within(panel).getAllByRole("textbox")[0], { target: { value: "blog-renamed" } });

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(getByText("20260101-000000-utc-abc.md")).toBeTruthy();
    expect(getByText(/still uses the old target name/)).toBeTruthy();
  });

  it("saves a brand-new target without a rename call", async () => {
    const { getByRole } = await renderModal();
    mock.saveSettings.mockResolvedValue(settings());
    mock.saveGenerationPrompts.mockResolvedValue(genPrompts());
    mock.saveAnalysisPrompts.mockResolvedValue(prompts());
    mock.saveTargets.mockResolvedValue(targets());

    const panel = openTab(getByRole, "Targets");
    fireEvent.click(within(panel).getByText("+ Add Target"));
    fireEvent.change(within(getByRole("tabpanel")).getAllByRole("textbox")[1], {
      target: { value: "social" },
    });

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // A new target has no originalName, so renameTarget is never issued.
    expect(mock.renameTarget).not.toHaveBeenCalled();
    expect(mock.saveTargets).toHaveBeenCalled();
  });
});

describe("SettingsModal — Analysis tab", () => {
  it("edits a prompt's name and text", async () => {
    const { getByRole } = await renderModal();
    const panel = openTab(getByRole, "Analysis");
    const name = within(panel).getAllByRole("textbox")[0];
    fireEvent.change(name, { target: { value: "Reviewed" } });
    expect((name as HTMLInputElement).value).toBe("Reviewed");
    // Editing makes the form dirty.
    expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("flags a prompt missing its name or text", async () => {
    const { getByRole, getByText } = await renderModal();
    const panel = openTab(getByRole, "Analysis");
    const inputs = within(panel).getAllByRole("textbox"); // [name, text]
    fireEvent.change(inputs[0], { target: { value: "" } });
    expect(getByText("Name is required.")).toBeTruthy();
    fireEvent.change(inputs[1], { target: { value: "" } });
    expect(getByText("Prompt text is required.")).toBeTruthy();
  });

  it("adds and removes analysis prompt rows", async () => {
    const { getByRole } = await renderModal();
    const panel = openTab(getByRole, "Analysis");
    fireEvent.click(within(panel).getByText("+ Add Prompt"));
    // Two rows now: each has a Name + Prompt text textbox → 4 textboxes.
    expect(within(getByRole("tabpanel")).getAllByRole("textbox")).toHaveLength(4);

    fireEvent.click(within(getByRole("tabpanel")).getAllByRole("button", { name: "Delete" })[1]);
    expect(within(getByRole("tabpanel")).getAllByRole("textbox")).toHaveLength(2);
  });

  it("restores the built-in analysis prompts", async () => {
    // seedLoaders sets the defaults to the standard fixture, so seed manually
    // with a *distinct* default and render directly to keep the override.
    mock.getSettings.mockResolvedValue(settings());
    mock.getAnthropicSettings.mockResolvedValue(anthropic());
    mock.getGenerationPromptDefaults.mockResolvedValue(genPrompts());
    mock.getGenerationPrompts.mockResolvedValue(genPrompts());
    mock.listTargets.mockResolvedValue(targets());
    mock.listAnalysisPromptDefaults.mockResolvedValue([
      { name: "Built-in", text: "Built-in {content}" },
    ]);
    mock.listAnalysisPrompts.mockResolvedValue(prompts());

    const { getByRole } = render(
      <ConfirmProvider>
        <SettingsModal onClose={vi.fn()} onSettingsChanged={vi.fn()} />
      </ConfirmProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const panel = openTab(getByRole, "Analysis");
    fireEvent.click(within(panel).getByText("Reset analysis prompts"));
    // The restored name/text land in the row's inputs (value, not text content).
    const p = getByRole("tabpanel");
    expect(within(p).getByDisplayValue("Built-in")).toBeTruthy();
    expect(within(p).getByDisplayValue("Built-in {content}")).toBeTruthy();
  });
});

describe("SettingsModal — Generation tab", () => {
  it("edits a generation prompt", async () => {
    const { getByRole } = await renderModal();
    const panel = openTab(getByRole, "Generation");
    const titleField = within(panel).getAllByRole("textbox")[0];
    fireEvent.change(titleField, { target: { value: "Make a punchy title" } });
    expect((titleField as HTMLTextAreaElement).value).toBe("Make a punchy title");
    expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("restores the built-in generation prompts", async () => {
    // Seed manually so the distinct default survives (renderModal/seedLoaders
    // would reset getGenerationPromptDefaults to the standard fixture).
    mock.getSettings.mockResolvedValue(settings());
    mock.getAnthropicSettings.mockResolvedValue(anthropic());
    mock.getGenerationPromptDefaults.mockResolvedValue({
      prompts: { title: "DEFAULT TITLE PROMPT" },
    });
    mock.getGenerationPrompts.mockResolvedValue({ prompts: { title: "" } });
    mock.listTargets.mockResolvedValue(targets());
    mock.listAnalysisPromptDefaults.mockResolvedValue(prompts());
    mock.listAnalysisPrompts.mockResolvedValue(prompts());

    const { getByRole } = render(
      <ConfirmProvider>
        <SettingsModal onClose={vi.fn()} onSettingsChanged={vi.fn()} />
      </ConfirmProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const panel = openTab(getByRole, "Generation");
    fireEvent.click(within(panel).getByText("Reset generation prompts"));
    expect((within(getByRole("tabpanel")).getAllByRole("textbox")[0] as HTMLTextAreaElement).value).toBe(
      "DEFAULT TITLE PROMPT",
    );
  });
});

describe("SettingsModal — dirty-close confirmation", () => {
  it("closes immediately when nothing changed", async () => {
    const { getByLabelText, onClose } = await renderModal();
    fireEvent.click(getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks to discard when dirty, closing only after confirming", async () => {
    const { getByRole, getByDisplayValue, onClose } = await renderModal();
    // Dirty the General tab.
    fireEvent.change(getByDisplayValue("UTC"), { target: { value: "Asia/Tokyo" } });

    fireEvent.keyDown(document, { key: "Escape" });
    const discard = await within(document.body).findByText("Discard Changes");
    expect(discard).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: "Discard" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the modal open when the discard is declined", async () => {
    const { getByRole, getByDisplayValue, onClose } = await renderModal();
    fireEvent.change(getByDisplayValue("UTC"), { target: { value: "Asia/Tokyo" } });
    fireEvent.keyDown(document, { key: "Escape" });
    await within(document.body).findByText("Discard Changes");
    fireEvent.click(getByRole("button", { name: "Keep Editing" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SettingsModal — set writes and reset", () => {
  it("theme Save leaves every workspace set untouched", async () => {
    const { getByRole } = await renderModal();
    fireEvent.click(getByRole("radio", { name: "Dark" }));
    await act(async () => { fireEvent.click(getByRole("button", { name: "Save" })); });
    expect(mock.saveAppSettings).toHaveBeenCalledWith({ theme: "dark", language: "system" });
    expect(mock.saveSettings).not.toHaveBeenCalled();
    expect(mock.saveTargets).not.toHaveBeenCalled();
    expect(mock.saveGenerationPrompts).not.toHaveBeenCalled();
    expect(mock.saveAnalysisPrompts).not.toHaveBeenCalled();
  });

  it.each([
    ["Generation", "Reset generation prompts", "generation"],
    ["Analysis", "Reset analysis prompts", "analysis"],
  ] as const)("%s reset fills the draft with the built-ins, which Save sends", async (tab, resetLabel, kind) => {
    mock.getGenerationPrompts.mockResolvedValueOnce({ prompts: { title: "Mine" } });
    mock.listAnalysisPrompts.mockResolvedValueOnce([{ name: "Mine", text: "Mine {content}" }]);
    const { getByRole, onClose } = await renderModal();
    mock.saveGenerationPrompts.mockResolvedValue(genPrompts());
    mock.saveAnalysisPrompts.mockResolvedValue(prompts());
    const panel = openTab(getByRole, tab);
    fireEvent.click(within(panel).getByRole("button", { name: resetLabel }));
    expect(mock.saveGenerationPrompts).not.toHaveBeenCalled();
    expect(mock.saveAnalysisPrompts).not.toHaveBeenCalled();
    expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(getByRole("button", { name: "Save" })); });
    if (kind === "generation") {
      expect(mock.saveGenerationPrompts).toHaveBeenCalledWith(genPrompts());
      expect(mock.saveAnalysisPrompts).not.toHaveBeenCalled();
    } else {
      expect(mock.saveAnalysisPrompts).toHaveBeenCalledWith(prompts());
      expect(mock.saveGenerationPrompts).not.toHaveBeenCalled();
    }
    expect(mock.saveSettings).not.toHaveBeenCalled();
    expect(mock.saveTargets).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
