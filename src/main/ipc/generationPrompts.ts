import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import { workspaceSetIssue } from "@shared/configSets";
import type { GenerationPromptsData } from "@shared/types";
import { getGenerationPrompts, saveGenerationPrompts } from "../storageAccess.js";
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

  ipcMain.handle(CHANNELS.getGenerationPrompts, async (_event, wsId: string) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const prompts = await getGenerationPrompts(dir);
    info("generation prompts loaded", { workspace: wsId, count: Object.keys(prompts.prompts).length });
    return prompts;
  });

  ipcMain.handle(CHANNELS.saveGenerationPrompts, async (_event, wsId: string, body: unknown) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const issue = workspaceSetIssue("generationPrompts", body);
    if (issue !== null) throw new Error(issue);
    const prompts = await saveGenerationPrompts(dir, { prompts: (body as GenerationPromptsData).prompts });
    info("generation prompts saved", { workspace: wsId, count: Object.keys(prompts.prompts).length });
    return prompts;
  });
}
