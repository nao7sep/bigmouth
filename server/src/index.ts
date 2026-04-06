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
import { settingsRouter } from "./routes/settings.js";
import { targetsRouter } from "./routes/targets.js";
import { aiConfigsRouter } from "./routes/aiConfigs.js";
import { analysisPromptsRouter } from "./routes/analysisPrompts.js";
import { generationPromptsRouter } from "./routes/generationPrompts.js";
import { analysisRouter } from "./routes/analysis.js";
import { generationRouter } from "./routes/generation.js";
import { assetsRouter } from "./routes/assets.js";
import { initConfigStore } from "./services/configStore.js";
import { initAssetStore } from "./services/assetStore.js";

// Resolve data directory (creates defaults on first run)
const dataDirectory = resolveDataDirectory();

// Initialize services
initLogger(dataDirectory);
initPostStore(dataDirectory);
initConfigStore(dataDirectory);
initAssetStore(dataDirectory);

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
app.use("/api/settings", settingsRouter);
app.use("/api/targets", targetsRouter);
app.use("/api/ai-configs", aiConfigsRouter);
app.use("/api/prompts", analysisPromptsRouter);
app.use("/api/generation-prompts", generationPromptsRouter);
app.use("/api/analyze", analysisRouter);
app.use("/api/generate", generationRouter);
app.use("/api/assets", assetsRouter);

// Serve uploaded asset files at /assets/:postId/:filename
const assetsStaticDir = path.join(dataDirectory, "assets");
app.use("/assets", express.static(assetsStaticDir));

app.listen(port, "127.0.0.1", () => {
  info(`Server started on port ${port}, data directory: ${dataDirectory}`);
});
