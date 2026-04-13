import express from "express";
import cors from "cors";
import { initAppDir, getAppConfig, getLogsDir } from "./services/workspaceStore.js";
import { initLogger, info, error as logError } from "./services/logger.js";
import { DEFAULT_PORT } from "./shared/defaults.js";
import { resolveWorkspace } from "./middleware/workspaceResolver.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { postsRouter } from "./routes/posts.js";
import { settingsRouter } from "./routes/settings.js";
import { targetsRouter } from "./routes/targets.js";
import { aiConfigsRouter } from "./routes/aiConfigs.js";
import { analysisPromptsRouter } from "./routes/analysisPrompts.js";
import { generationPromptsRouter } from "./routes/generationPrompts.js";
import { analysisRouter } from "./routes/analysis.js";
import { generationRouter } from "./routes/generation.js";
import { assetsRouter } from "./routes/assets.js";

// Initialize app directory and load config
const appConfig = initAppDir();
initLogger(getLogsDir());

const port = appConfig.port || DEFAULT_PORT;

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Workspace management (no workspace prefix)
app.use("/api/workspaces", workspacesRouter);

// All workspace-scoped routes under /api/w/:wsId/
app.use("/api/w/:wsId", resolveWorkspace);
app.use("/api/w/:wsId/posts", postsRouter);
app.use("/api/w/:wsId/settings", settingsRouter);
app.use("/api/w/:wsId/targets", targetsRouter);
app.use("/api/w/:wsId/ai-configs", aiConfigsRouter);
app.use("/api/w/:wsId/analysis-prompts", analysisPromptsRouter);
app.use("/api/w/:wsId/generation-prompts", generationPromptsRouter);
app.use("/api/w/:wsId/analyze", analysisRouter);
app.use("/api/w/:wsId/generate", generationRouter);
app.use("/api/w/:wsId/assets", assetsRouter);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logError(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(port, "127.0.0.1", () => {
  info(`Server started on port ${port}, ${appConfig.workspaces.length} workspace(s) configured`);
});
