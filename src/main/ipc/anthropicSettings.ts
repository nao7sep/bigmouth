import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import type { AnthropicSettingsInput } from "@shared/types";
import { AI_ROLE_IDS } from "@shared/aiModels";
import { modelSetKey, thinkingSetKey, workspaceSetIssue } from "@shared/configSets";
import { getAnthropicSettingsForClient, saveAnthropicSettings } from "../storageAccess.js";
import { info } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The section as Save sends it, checked set by set with the validator the store reads with. */
function anthropicInput(body: unknown): AnthropicSettingsInput {
  if (!object(body) || !object(body.models) || !object(body.thinking)) {
    throw new Error("settings must hold an endpoint, models and thinking");
  }
  const { models, thinking } = body;
  const issues = [
    workspaceSetIssue("anthropic.endpoint", body.endpoint),
    ...AI_ROLE_IDS.flatMap((role) => [
      workspaceSetIssue(modelSetKey(role), models[role]),
      workspaceSetIssue(thinkingSetKey(role), thinking[role]),
    ]),
  ].filter((issue): issue is string => issue !== null);
  if (issues.length > 0) throw new Error(issues[0]);
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw new Error("apiKey must be a string");
  return body as unknown as AnthropicSettingsInput;
}

export function registerAnthropicSettingsHandlers(): void {
  ipcMain.handle(CHANNELS.getAnthropicSettings, async (_event, wsId: string) => {
    const ws = await resolveWorkspace(wsId);
    const settings = await getAnthropicSettingsForClient(ws);
    info("anthropic settings loaded", { workspace: ws.id, hasApiKey: settings.hasApiKey });
    return settings;
  });

  ipcMain.handle(CHANNELS.saveAnthropicSettings, async (_event, wsId: string, body: unknown) => {
    const ws = await resolveWorkspace(wsId);
    const input = anthropicInput(body);
    const settings = await saveAnthropicSettings(ws, input);
    info("anthropic settings saved", {
      workspace: ws.id,
      endpoint: settings.endpoint,
      models: settings.models,
      thinking: settings.thinking,
      apiKeyChanged: Boolean(input.apiKey?.trim()),
    });
    return settings;
  });
}
