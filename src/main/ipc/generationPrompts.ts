import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import type { GenerationPromptsData } from "@shared/types";
import { getGenerationPrompts, saveGenerationPrompts } from "../core/services/configStore.js";
import { DEFAULT_GENERATION_PROMPTS_DATA } from "../core/shared/defaults.js";
import { info } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

export function registerGenerationPromptHandlers(): void {
  ipcMain.handle(CHANNELS.getGenerationPromptDefaults, () => {
    info("generation prompt defaults loaded", {
      count: Object.keys(DEFAULT_GENERATION_PROMPTS_DATA.prompts).length,
    });
    return DEFAULT_GENERATION_PROMPTS_DATA;
  });

  ipcMain.handle(CHANNELS.getGenerationPrompts, (_event, wsId: string) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    const prompts = getGenerationPrompts(dir);
    info("generation prompts loaded", { workspace: wsId, count: Object.keys(prompts.prompts).length });
    return prompts;
  });

  ipcMain.handle(CHANNELS.saveGenerationPrompts, (_event, wsId: string, body: unknown) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    const b = body as { prompts?: unknown } | null | undefined;
    if (!b?.prompts || typeof b.prompts !== "object" || Array.isArray(b.prompts)) {
      throw new Error("prompts must be an object");
    }
    if (!Object.values(b.prompts as Record<string, unknown>).every((v) => typeof v === "string")) {
      throw new Error("every prompt value must be a string");
    }
    const prompts = saveGenerationPrompts(dir, body as GenerationPromptsData);
    info("generation prompts saved", { workspace: wsId, count: Object.keys(prompts.prompts).length });
    return prompts;
  });
}
