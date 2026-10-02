import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import { workspaceSetHasShape } from "@shared/configSets";
import { isMetadataField } from "@shared/metadataFields";
import type { GenerationPromptsData } from "@shared/types";
import { getGenerationPrompts, saveGenerationPrompts, resetGenerationPrompts } from "../core/services/configStore.js";
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

  ipcMain.handle(CHANNELS.resetGenerationPrompts, (_event, wsId: string) => {
    const prompts = resetGenerationPrompts(resolveWorkspace(wsId).dataDirectory);
    info("generation prompts reset", { workspace: wsId });
    return prompts;
  });

  ipcMain.handle(CHANNELS.saveGenerationPrompts, (_event, wsId: string, body: unknown) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    if (
      !workspaceSetHasShape("generationPrompts", body) ||
      !Object.keys((body as GenerationPromptsData).prompts).every(isMetadataField)
    ) {
      throw new Error("prompts must map every generation prompt key, and no other, to a string");
    }
    const prompts = saveGenerationPrompts(dir, { prompts: (body as GenerationPromptsData).prompts });
    info("generation prompts saved", { workspace: wsId, count: Object.keys(prompts.prompts).length });
    return prompts;
  });
}
