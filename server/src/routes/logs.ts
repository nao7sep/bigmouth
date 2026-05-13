import { Router } from "express";
import { getCurrentLogFilePath, revealCurrentLogFile } from "../services/logger.js";
import * as logger from "../services/logger.js";

export const logsRouter = Router();

logsRouter.get("/current", (_req, res) => {
  const path = getCurrentLogFilePath();
  if (!path) {
    logger.warn(`Current log lookup failed: requestId=${res.locals.requestId ?? "-"}`);
    res.status(404).json({ error: "Current log file is not available" });
    return;
  }

  logger.info(`Current log loaded: requestId=${res.locals.requestId ?? "-"}, path=${path}`);
  res.json({ path });
});

logsRouter.post("/current/reveal", async (_req, res) => {
  try {
    const path = await revealCurrentLogFile();
    logger.info(`Current log revealed: requestId=${res.locals.requestId ?? "-"}, path=${path}`);
    res.json({ path });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reveal current log file";
    logger.error(`Current log reveal failed: requestId=${res.locals.requestId ?? "-"}, message=${message}`);
    res.status(500).json({ error: message });
  }
});
