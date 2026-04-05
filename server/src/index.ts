import express from "express";
import cors from "cors";
import { resolveDataDirectory } from "./services/dataDir.js";
import { initLogger, info } from "./services/logger.js";
import { DEFAULT_PORT } from "./shared/defaults.js";

// Resolve data directory (creates defaults on first run)
const dataDirectory = resolveDataDirectory();

// Initialize logging (creates log file for this session)
initLogger(dataDirectory);

// Read settings to get configured port
import fs from "node:fs";
import path from "node:path";
import type { Settings } from "./shared/types.js";

const settingsPath = path.join(dataDirectory, "settings.json");
const settings: Settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
const port = settings.port || DEFAULT_PORT;

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", dataDirectory });
});

app.listen(port, "127.0.0.1", () => {
  info(`Server started on port ${port}, data directory: ${dataDirectory}`);
});
