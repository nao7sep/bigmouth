import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent, within } from "@testing-library/react";
import type {
  Settings,
  Target,
  AnalysisPrompt,
  AiConfigsData,
  GenerationPromptsData,
} from "@shared/types";
import { DEFAULT_CONTENT_FONT } from "@shared/types";

// SettingsModal reaches the main process only through these api functions; mock
// the whole module so the dialog renders against in-memory fixtures.
vi.mock("@renderer/api", () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  listTargets: vi.fn(),
  saveTargets: vi.fn(),
  renameTarget: vi.fn(),
  listAnalysisPrompts: vi.fn(),
  listAnalysisPromptDefaults: vi.fn(),
  saveAnalysisPrompts: vi.fn(),
  listAiConfigs: vi.fn(),
  createAiConfig: vi.fn(),
  updateAiConfig: vi.fn(),
  deleteAiConfig: vi.fn(),
  setActiveAiConfig: vi.fn(),
  getGenerationPrompts: vi.fn(),
  getGenerationPromptDefaults: vi.fn(),
  saveGenerationPrompts: vi.fn(),
  rebuildPostIndex: vi.fn(),
}));

import { SettingsModal } from "@renderer/components/SettingsModal";
import { ConfirmProvider } from "@renderer/components/ConfirmHost";
import * as api from "@renderer/api";

const mock = {
  getSettings: vi.mocked(api.getSettings),
  saveSettings: vi.mocked(api.saveSettings),
  listTargets: vi.mocked(api.listTargets),
  saveTargets: vi.mocked(api.saveTargets),
  renameTarget: vi.mocked(api.renameTarget),
  listAnalysisPrompts: vi.mocked(api.listAnalysisPrompts),
  listAnalysisPromptDefaults: vi.mocked(api.listAnalysisPromptDefaults),
  saveAnalysisPrompts: vi.mocked(api.saveAnalysisPrompts),
  listAiConfigs: vi.mocked(api.listAiConfigs),
  createAiConfig: vi.mocked(api.createAiConfig),
  updateAiConfig: vi.mocked(api.updateAiConfig),
  deleteAiConfig: vi.mocked(api.deleteAiConfig),
  setActiveAiConfig: vi.mocked(api.setActiveAiConfig),
  getGenerationPrompts: vi.mocked(api.getGenerationPrompts),
  getGenerationPromptDefaults: vi.mocked(api.getGenerationPromptDefaults),
  saveGenerationPrompts: vi.mocked(api.saveGenerationPrompts),
};

function settings(): Settings {
  return {
    timezone: "UTC",
    supportedLanguages: ["en", "ja"],
    publishedPostsPerLoad: 50,
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

function aiConfigs(overrides?: Partial<AiConfigsData>): AiConfigsData {
  return {
    activeId: "c1",
    configs: [
      { id: "c1", name: "Primary", provider: "anthropic", apiKey: "", model: "claude-sonnet-4-6", thinking: false, maxTokens: 12800 },
    ],
    ...overrides,
  };
}

// Seed every loader so the modal's all-or-nothing Promise.all resolves and the
// editor renders. `ai` lets a test vary just the AI fixture.
function seedLoaders(ai: AiConfigsData = aiConfigs()) {
  mock.getSettings.mockResolvedValue(settings());
  mock.listAiConfigs.mockResolvedValue(ai);
  mock.getGenerationPromptDefaults.mockResolvedValue(genPrompts());
  mock.getGenerationPrompts.mockResolvedValue(genPrompts());
  mock.listTargets.mockResolvedValue(targets());
  mock.listAnalysisPromptDefaults.mockResolvedValue(prompts());
  mock.listAnalysisPrompts.mockResolvedValue(prompts());
}

async function renderModal(ai?: AiConfigsData) {
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

// Switch to the AI Configs tab and return its panel for scoped queries.
function openAiTab(getByRole: ReturnType<typeof render>["getByRole"]) {
  fireEvent.click(getByRole("tab", { name: "AI Configs" }));
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
    mock.listAiConfigs.mockResolvedValue(aiConfigs());
    mock.getGenerationPromptDefaults.mockResolvedValue(genPrompts());
    mock.getGenerationPrompts.mockResolvedValue(genPrompts());
    mock.listTargets.mockResolvedValue(targets());
    mock.listAnalysisPromptDefaults.mockResolvedValue(prompts());
    mock.listAnalysisPrompts.mockResolvedValue(prompts());

    const { getByText, queryByRole } = render(
      <ConfirmProvider>
        <SettingsModal onClose={vi.fn()} onSettingsChanged={vi.fn()} />
      </ConfirmProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getByText("disk gone")).toBeTruthy();
    // No tablist is rendered while the load failed.
    expect(queryByRole("tablist")).toBeNull();
  });

  it("renders all five tabs and switches the visible panel", async () => {
    const { getByRole, getByText } = await renderModal();
    for (const label of ["General", "Targets", "AI Configs", "Analysis", "Generation"]) {
      expect(getByRole("tab", { name: label })).toBeTruthy();
    }
    // General is the default panel.
    expect(getByText("Timezone (IANA)")).toBeTruthy();

    // Switch to AI Configs.
    const panel = openAiTab(getByRole);
    expect(within(panel).getByText("Active AI config")).toBeTruthy();
  });
});

describe("SettingsModal — AI Configs tab hints/placeholders", () => {
  it("shows the env-key hint when usingEnvKey is set", async () => {
    const { getByRole } = await renderModal(
      aiConfigs({
        configs: [
          { id: "c1", name: "Primary", provider: "anthropic", apiKey: "", model: "claude-sonnet-5", thinking: false, maxTokens: 12800, usingEnvKey: true },
        ],
      }),
    );
    const panel = openAiTab(getByRole);
    expect(
      within(panel).getByText("Using ANTHROPIC_API_KEY; it overrides any stored key."),
    ).toBeTruthy();
  });

  it("uses the keep-current placeholder when a key is already stored", async () => {
    const { getByRole } = await renderModal(
      aiConfigs({
        configs: [
          { id: "c1", name: "Primary", provider: "anthropic", apiKey: "", model: "claude-sonnet-5", thinking: false, maxTokens: 12800, hasApiKey: true },
        ],
      }),
    );
    const panel = openAiTab(getByRole);
    const apiKeyInput = within(panel).getByPlaceholderText("Leave blank to keep current key");
    expect(apiKeyInput).toBeTruthy();
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

describe("SettingsModal — AI Configs add/edit/delete rows", () => {
  it("adds a new config row", async () => {
    const { getByRole } = await renderModal();
    const panel = openAiTab(getByRole);
    expect(within(panel).getAllByText("Name")).toHaveLength(1);

    fireEvent.click(within(panel).getByText("+ Add AI Config"));
    // A second Name field appears for the new row.
    expect(within(getByRole("tabpanel")).getAllByText("Name")).toHaveLength(2);
  });

  it("disables Delete when only one config remains, and enables it once a second exists", async () => {
    const { getByRole } = await renderModal();
    const panel = openAiTab(getByRole);
    const deleteBtn = within(panel).getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);

    fireEvent.click(within(panel).getByText("+ Add AI Config"));
    const deletes = within(getByRole("tabpanel")).getAllByRole("button", {
      name: "Delete",
    }) as HTMLButtonElement[];
    expect(deletes.every((b) => !b.disabled)).toBe(true);
  });

  it("deletes a config row", async () => {
    const { getByRole } = await renderModal(
      aiConfigs({
        activeId: "c1",
        configs: [
          { id: "c1", name: "Primary", provider: "anthropic", apiKey: "", model: "claude-sonnet-5", thinking: false, maxTokens: 12800 },
          { id: "c2", name: "Secondary", provider: "anthropic", apiKey: "", model: "claude-sonnet-5", thinking: false, maxTokens: 12800 },
        ],
      }),
    );
    const panel = openAiTab(getByRole);
    expect(within(panel).getAllByText("Name")).toHaveLength(2);

    const deletes = within(panel).getAllByRole("button", { name: "Delete" });
    fireEvent.click(deletes[1]); // remove "Secondary"
    expect(within(getByRole("tabpanel")).getAllByText("Name")).toHaveLength(1);
  });
});

describe("SettingsModal — Save flow (AI config sequence)", () => {
  it("disables Save until the form is dirty", async () => {
    const { getByRole } = await renderModal();
    const save = getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Edit a config name to make it dirty.
    const panel = openAiTab(getByRole);
    const nameInput = within(panel).getAllByRole("textbox")[0];
    fireEvent.change(nameInput, { target: { value: "Renamed" } });
    expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("creates, updates, sets-active and deletes in order on Save", async () => {
    // Start with two configs, c1 active.
    const initial = aiConfigs({
      activeId: "c1",
      configs: [
        { id: "c1", name: "Primary", provider: "anthropic", apiKey: "", model: "claude-opus-4-8", thinking: false, maxTokens: 12800 },
        { id: "c2", name: "Secondary", provider: "anthropic", apiKey: "", model: "claude-sonnet-5", thinking: true, maxTokens: 12800 },
      ],
    });
    const { getByRole, onClose, onSettingsChanged } = await renderModal(initial);

    // Each AI api call resolves with some data; the exact value is not asserted.
    mock.createAiConfig.mockResolvedValue(initial);
    mock.updateAiConfig.mockResolvedValue(initial);
    mock.setActiveAiConfig.mockResolvedValue(initial);
    mock.deleteAiConfig.mockResolvedValue(initial);
    mock.saveSettings.mockResolvedValue(settings());
    mock.saveGenerationPrompts.mockResolvedValue(genPrompts());
    mock.saveAnalysisPrompts.mockResolvedValue(prompts());
    mock.saveTargets.mockResolvedValue(targets());

    const panel = openAiTab(getByRole);

    // The API Key input is type="password" (no textbox role) and Model is a select,
    // so the role="textbox" elements are Name only — one per row. Comboboxes are the
    // "Active AI config" select first, then Provider + Model per row.

    // 1. Add a new config; with two existing rows its Name is textbox 2 and its
    //    Model is combobox 6 ([active, c1.provider, c1.model, c2.provider, c2.model,
    //    new.provider, new.model]).
    fireEvent.click(within(panel).getByText("+ Add AI Config"));
    let p = getByRole("tabpanel");
    fireEvent.change(within(p).getAllByRole("textbox")[2], { target: { value: "New" } });
    p = getByRole("tabpanel");
    fireEvent.change(within(p).getAllByRole("combobox")[6], { target: { value: "claude-haiku-4-5" } });

    // 2. Edit c1's model (an update) — combobox index 2.
    p = getByRole("tabpanel");
    fireEvent.change(within(p).getAllByRole("combobox")[2], { target: { value: "claude-sonnet-4-6" } });

    // 3. Change the active config to c2 — the first combobox.
    p = getByRole("tabpanel");
    const activeSelect = within(p).getAllByRole("combobox")[0];
    fireEvent.change(activeSelect, { target: { value: "c2" } });

    // 4. Active is now c2; the store refuses to delete the active config, so
    //    delete c1 (the first Delete button) and keep c2 as the survivor.
    p = getByRole("tabpanel");
    const deleteButtons = within(p).getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[0]); // remove c1

    // Save.
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The new config was created — and picking Haiku re-derived the fields that
    // belong to the model: thinking off (it rejects thinking) and its own budget.
    expect(mock.createAiConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "New",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        thinking: false,
        maxTokens: 6400,
      }),
    );
    // The active swap was issued for c2.
    expect(mock.setActiveAiConfig).toHaveBeenCalledWith("c2");
    // c1 was deleted.
    expect(mock.deleteAiConfig).toHaveBeenCalledWith("c1");
    // The umbrella save fired and the modal closed.
    expect(mock.saveSettings).toHaveBeenCalled();
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sends an apiKey on create only when one was typed", async () => {
    const { getByRole } = await renderModal();
    mock.createAiConfig.mockResolvedValue(aiConfigs());
    mock.saveSettings.mockResolvedValue(settings());
    mock.saveGenerationPrompts.mockResolvedValue(genPrompts());
    mock.saveAnalysisPrompts.mockResolvedValue(prompts());
    mock.saveTargets.mockResolvedValue(targets());

    const panel = openAiTab(getByRole);
    fireEvent.click(within(panel).getByText("+ Add AI Config"));

    // One existing row + the new row → textboxes are [c1.name, new.name] (Model is a
    // select). Fill the new row's Name, leave the API key blank.
    const p = getByRole("tabpanel");
    fireEvent.change(within(p).getAllByRole("textbox")[1], { target: { value: "Fresh" } });

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // apiKey omitted (undefined) because it was left blank. The row was added without
    // touching Model, so it carries the default model and that model's own budget.
    expect(mock.createAiConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Fresh",
        model: "claude-sonnet-5",
        maxTokens: 12800,
        apiKey: undefined,
      }),
    );
  });

  it("surfaces a save error and keeps the modal open", async () => {
    const { getByRole, onClose, getByText } = await renderModal();
    mock.saveSettings.mockRejectedValue(new Error("write failed"));
    mock.saveGenerationPrompts.mockResolvedValue(genPrompts());
    mock.saveAnalysisPrompts.mockResolvedValue(prompts());
    mock.saveTargets.mockResolvedValue(targets());
    mock.listAiConfigs.mockResolvedValue(aiConfigs());

    // Make the form dirty.
    const panel = openAiTab(getByRole);
    fireEvent.change(within(panel).getAllByRole("textbox")[0], { target: { value: "Renamed" } });

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getByText("write failed")).toBeTruthy();
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

describe("SettingsModal — General tab validation", () => {
  it("flags an invalid IANA timezone and a required (blank) timezone", async () => {
    const { getByRole, getByDisplayValue, queryByText } = await renderModal();
    const tz = getByDisplayValue("UTC");

    // A nonsense zone fails the Intl probe.
    fireEvent.change(tz, { target: { value: "Not/AZone" } });
    expect(queryByText('"Not/AZone" is not a valid IANA timezone.')).toBeTruthy();

    // Clearing it triggers the required message instead.
    fireEvent.change(tz, { target: { value: "" } });
    expect(queryByText("Timezone is required.")).toBeTruthy();

    // A valid zone clears the error and the form is dirty → Save enabled.
    fireEvent.change(getByRole("tabpanel").querySelector("input")!, {
      target: { value: "Asia/Tokyo" },
    });
    expect(queryByText("Timezone is required.")).toBeNull();
  });

  it("validates the supported-languages list: empty, bad code, and duplicates", async () => {
    const { getByDisplayValue, getByText, queryByText } = await renderModal();
    const langs = getByDisplayValue("en, ja");

    fireEvent.change(langs, { target: { value: "" } });
    expect(getByText("At least one language is required.")).toBeTruthy();

    fireEvent.change(langs, { target: { value: "eng" } });
    expect(getByText("Each language must be a 2-letter lowercase code (e.g. en, ja).")).toBeTruthy();

    fireEvent.change(langs, { target: { value: "en, en" } });
    expect(getByText("Languages must not contain duplicates.")).toBeTruthy();

    fireEvent.change(langs, { target: { value: "en, ja" } });
    expect(queryByText("Languages must not contain duplicates.")).toBeNull();
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
    mockRebuildPostIndex.mockResolvedValue({ count: 3 });

    await act(async () => {
      fireEvent.click(getByText("Rebuild index"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getByText("Rebuilt the index from 3 posts.")).toBeTruthy();
  });

  it("uses the singular noun for a one-post rebuild", async () => {
    const { getByText } = await renderModal();
    mockRebuildPostIndex.mockResolvedValue({ count: 1 });
    await act(async () => {
      fireEvent.click(getByText("Rebuild index"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getByText("Rebuilt the index from 1 post.")).toBeTruthy();
  });

  it("surfaces a rebuild failure", async () => {
    const { getByText } = await renderModal();
    mockRebuildPostIndex.mockRejectedValue(new Error("index locked"));
    await act(async () => {
      fireEvent.click(getByText("Rebuild index"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getByText("index locked")).toBeTruthy();
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
    mock.listAiConfigs.mockResolvedValue(aiConfigs());
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
    mock.renameTarget.mockResolvedValue({ targets: targets(), postsUpdated: 2 });
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
    mock.listAiConfigs.mockResolvedValue(aiConfigs());
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
    mock.listAiConfigs.mockResolvedValue(aiConfigs());
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
