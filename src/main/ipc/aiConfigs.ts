import { ipcMain } from "electron";

import { CHANNELS, type AiConfigInput, type AiConfigPatch } from "@shared/ipc";
import { AI_PROVIDERS, validateMaxTokens, type AiProvider } from "@shared/types";
import {
  getAiConfigsForClient,
  createAiConfig,
  updateAiConfig,
  deleteAiConfig,
  setActiveAiConfig,
  type UpdateAiConfigPatch,
} from "../core/services/configStore.js";
import { info, warn, serializeError } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

// AI config IDs share nanoid's alphabet; rejecting odd characters keeps logs sane.
const ID_RE = /^[A-Za-z0-9_-]+$/;

function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
}

export function registerAiConfigHandlers(): void {
  ipcMain.handle(CHANNELS.listAiConfigs, (_event, wsId: string) => {
    const ws = resolveWorkspace(wsId);
    const configs = getAiConfigsForClient(ws);
    info("ai configs loaded", { workspace: wsId, configCount: configs.configs.length, activeId: configs.activeId });
    return configs;
  });

  ipcMain.handle(CHANNELS.createAiConfig, (_event, wsId: string, input: AiConfigInput) => {
    const ws = resolveWorkspace(wsId);
    if (typeof input?.id !== "string" || !ID_RE.test(input.id)) {
      throw new Error("id is required and must match [A-Za-z0-9_-]+");
    }
    if (typeof input.name !== "string") throw new Error("name must be a string");
    if (!isAiProvider(input.provider)) throw new Error(`provider must be one of: ${AI_PROVIDERS.join(", ")}`);
    if (typeof input.model !== "string") throw new Error("model must be a string");
    if (typeof input.thinking !== "boolean") throw new Error("thinking must be a boolean");
    const budgetError = validateMaxTokens(input.maxTokens);
    if (budgetError) throw new Error(budgetError);
    if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new Error("apiKey must be a string");
    try {
      const result = createAiConfig(ws, {
        id: input.id,
        name: input.name,
        provider: input.provider,
        model: input.model,
        thinking: input.thinking,
        maxTokens: input.maxTokens,
        apiKey: input.apiKey,
      });
      info("ai config created", { workspace: wsId, configId: input.id });
      return result;
    } catch (err) {
      warn("ai config create failed", { workspace: wsId, configId: input.id, error: serializeError(err) });
      throw err instanceof Error ? err : new Error("Failed to create AI config");
    }
  });

  ipcMain.handle(CHANNELS.setActiveAiConfig, (_event, wsId: string, id: string) => {
    const ws = resolveWorkspace(wsId);
    if (typeof id !== "string") throw new Error("id must be a string");
    if (id !== "" && !ID_RE.test(id)) throw new Error("id is malformed");
    try {
      const result = setActiveAiConfig(ws, id);
      info("ai active config set", { workspace: wsId, activeId: id || null });
      return result;
    } catch (err) {
      warn("ai active config set failed", { workspace: wsId, configId: id, error: serializeError(err) });
      throw err instanceof Error ? err : new Error("Failed to set active AI config");
    }
  });

  // Partial update: a field omitted is preserved; apiKey "" clears, non-empty replaces.
  ipcMain.handle(CHANNELS.updateAiConfig, (_event, wsId: string, id: string, body: AiConfigPatch) => {
    const ws = resolveWorkspace(wsId);
    if (!ID_RE.test(id)) throw new Error("id is malformed");
    const patch: UpdateAiConfigPatch = {};
    if (body?.name !== undefined) {
      if (typeof body.name !== "string") throw new Error("name must be a string");
      patch.name = body.name;
    }
    if (body?.provider !== undefined) {
      if (!isAiProvider(body.provider)) throw new Error(`provider must be one of: ${AI_PROVIDERS.join(", ")}`);
      patch.provider = body.provider;
    }
    if (body?.model !== undefined) {
      if (typeof body.model !== "string") throw new Error("model must be a string");
      patch.model = body.model;
    }
    if (body?.thinking !== undefined) {
      if (typeof body.thinking !== "boolean") throw new Error("thinking must be a boolean");
      patch.thinking = body.thinking;
    }
    if (body?.maxTokens !== undefined) {
      const err = validateMaxTokens(body.maxTokens);
      if (err) throw new Error(err);
      patch.maxTokens = body.maxTokens;
    }
    if (body?.apiKey !== undefined) {
      if (typeof body.apiKey !== "string") throw new Error("apiKey must be a string");
      patch.apiKey = body.apiKey;
    }
    try {
      const result = updateAiConfig(ws, id, patch);
      info("ai config updated", { workspace: wsId, configId: id, changed: Object.keys(patch) });
      return result;
    } catch (err) {
      warn("ai config update failed", { workspace: wsId, configId: id, error: serializeError(err) });
      throw err instanceof Error ? err : new Error("Failed to update AI config");
    }
  });

  ipcMain.handle(CHANNELS.deleteAiConfig, (_event, wsId: string, id: string) => {
    const ws = resolveWorkspace(wsId);
    if (!ID_RE.test(id)) throw new Error("id is malformed");
    try {
      const result = deleteAiConfig(ws, id);
      info("ai config deleted", { workspace: wsId, configId: id });
      return result;
    } catch (err) {
      warn("ai config delete failed", { workspace: wsId, configId: id, error: serializeError(err) });
      throw err instanceof Error ? err : new Error("Failed to delete AI config");
    }
  });
}
