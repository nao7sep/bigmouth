import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
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

// --- Origin guard (CSRF protection) ---
//
// The server binds to 127.0.0.1, but any browser running on the host can
// reach it — including pages from arbitrary origins the user happens to
// visit. There is no auth on this app, so without an Origin check, any
// such page could read or modify workspace data via fetch().
//
// Policy:
//   * No Origin header (same-origin GETs, curl, server-to-server) → allow.
//   * Origin matches the loopback host the server is listening on at the
//     same port (production, when the client is served from the same
//     origin) → allow.
//   * Origin matches a configured dev origin → allow.
//   * Anything else → 403.
const DEV_ORIGINS = new Set<string>([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

function isAllowedOrigin(origin: string): boolean {
  if (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
  ) {
    return true;
  }
  return DEV_ORIGINS.has(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    res.status(403).json({ error: "Forbidden origin" });
    return;
  }
  next();
});

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

// --- Static client (production build) ---
//
// In production (`npm run build && node server/dist/index.js`), the built
// client is shipped from the same origin so no cross-origin requests are
// needed at all. In dev, use `npm run dev` which proxies /api through Vite.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA fallback: any non-/api GET that didn't match a static file serves
  // index.html so client-side navigation works on hard reload.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logError(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(port, "127.0.0.1", () => {
  info(`Server started on port ${port}, ${appConfig.workspaces.length} workspace(s) configured`);
});
