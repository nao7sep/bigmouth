import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import type { AnalysisPrompt } from "@shared/types";
import { workspaceSetIssue } from "@shared/configSets";
import { getAnalysisPrompts, saveAnalysisPrompts } from "../storageAccess.js";
import { DEFAULT_ANALYSIS_PROMPTS } from "../core/shared/defaults.js";
import { info } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

export function registerAnalysisPromptHandlers(): void {
  ipcMain.handle(CHANNELS.listAnalysisPromptDefaults, () => {
    info("analysis prompt defaults loaded", { count: DEFAULT_ANALYSIS_PROMPTS.length });
    return DEFAULT_ANALYSIS_PROMPTS;
  });

  ipcMain.handle(CHANNELS.listAnalysisPrompts, async (_event, wsId: string) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const prompts = await getAnalysisPrompts(dir);
    info("analysis prompts loaded", { workspace: wsId, count: prompts.length });
    return prompts;
  });

  ipcMain.handle(CHANNELS.saveAnalysisPrompts, async (_event, wsId: string, body: unknown) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const issue = workspaceSetIssue("analysisPrompts", body);
    if (issue !== null) throw new Error(issue);
    const saved = await saveAnalysisPrompts(dir, body as AnalysisPrompt[]);
    info("analysis prompts saved", { workspace: wsId, count: saved.length });
    return saved;
  });
}
