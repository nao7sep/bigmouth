import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import type { AnalysisPrompt } from "@shared/types";
import { getAnalysisPrompts, saveAnalysisPrompts } from "../core/services/configStore.js";
import { DEFAULT_ANALYSIS_PROMPTS } from "../core/shared/defaults.js";
import { info } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

export function registerAnalysisPromptHandlers(): void {
  ipcMain.handle(CHANNELS.listAnalysisPromptDefaults, () => {
    info("analysis prompt defaults loaded", { count: DEFAULT_ANALYSIS_PROMPTS.length });
    return DEFAULT_ANALYSIS_PROMPTS;
  });

  ipcMain.handle(CHANNELS.listAnalysisPrompts, (_event, wsId: string) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    const prompts = getAnalysisPrompts(dir);
    info("analysis prompts loaded", { workspace: wsId, count: prompts.length });
    return prompts;
  });

  ipcMain.handle(CHANNELS.saveAnalysisPrompts, (_event, wsId: string, body: unknown) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    if (!Array.isArray(body)) throw new Error("analysis prompts must be an array");
    for (const prompt of body) {
      if (!prompt || typeof prompt !== "object") throw new Error("each prompt must be an object");
      const p = prompt as Record<string, unknown>;
      if (typeof p.name !== "string" || !p.name.trim()) throw new Error("each prompt needs a non-empty name");
      if (typeof p.text !== "string") throw new Error("each prompt needs a text string");
    }
    const saved = saveAnalysisPrompts(dir, body as AnalysisPrompt[]);
    info("analysis prompts saved", { workspace: wsId, count: saved.length });
    return saved;
  });
}
