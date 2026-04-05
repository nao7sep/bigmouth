import { Router } from "express";
import { getSettings, saveSettings } from "../services/configStore.js";

export const settingsRouter = Router();

/**
 * GET /api/settings
 *
 * Returns current settings. API key is deobfuscated (plain text).
 */
settingsRouter.get("/", (_req, res) => {
  res.json(getSettings());
});

/**
 * PUT /api/settings
 *
 * Replaces all settings. API key should be sent as plain text;
 * it will be obfuscated before writing to disk.
 */
settingsRouter.put("/", (req, res) => {
  const settings = req.body;
  saveSettings(settings);
  res.json(getSettings());
});
