import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDirectory } from "./services/dataDir.js";
import { initLogger, info } from "./services/logger.js";
import { initPostStore } from "./services/postStore.js";
import { DEFAULT_PORT } from "./shared/defaults.js";
import type { Settings } from "./shared/types.js";
import { postsRouter } from "./routes/posts.js";

// Resolve data directory (creates defaults on first run)
const dataDirectory = resolveDataDirectory();

// Initialize services
initLogger(dataDirectory);
initPostStore(dataDirectory);

// Read settings to get configured port
const settingsPath = path.join(dataDirectory, "settings.json");
const settings: Settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
const port = settings.port || DEFAULT_PORT;

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", dataDirectory });
});

app.use("/api/posts", postsRouter);

app.listen(port, "127.0.0.1", () => {
  info(`Server started on port ${port}, data directory: ${dataDirectory}`);
});
