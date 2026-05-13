import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { initAppDir, getAppConfig, getLogsDir } from "./services/workspaceStore.js";
import {
  initLogger,
  info,
  warn,
  error as logError,
  formatLogValue,
  formatRequestShape,
} from "./services/logger.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "./shared/defaults.js";
import { resolveWorkspace } from "./middleware/workspaceResolver.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { logsRouter } from "./routes/logs.js";
import { postsRouter } from "./routes/posts.js";
import { settingsRouter } from "./routes/settings.js";
import { targetsRouter } from "./routes/targets.js";
import { aiConfigsRouter } from "./routes/aiConfigs.js";
import { analysisPromptsRouter } from "./routes/analysisPrompts.js";
import { generationPromptsRouter } from "./routes/generationPrompts.js";
import { analysisRouter } from "./routes/analysis.js";
import { generationRouter } from "./routes/generation.js";
import { imagingRouter } from "./routes/imaging.js";
import { assetsRouter } from "./routes/assets.js";

// Initialize app directory and load config
const appConfig = initAppDir();
initLogger(getLogsDir());

const port = appConfig.port || DEFAULT_PORT;
const host = appConfig.host || DEFAULT_HOST;

const app = express();
let nextRequestId = 1;

// --- Origin guard (CSRF protection) ---
//
// The default deployment is loopback-only, but a single user may also choose
// to expose bigmouth to a trusted LAN (see README "LAN access"). In either
// case, any browser that can reach the server could be tricked into making
// requests from a third-party page; the Origin guard is what prevents that.
//
// Policy:
//   * No Origin header (same-origin GETs, curl, server-to-server) → allow.
//   * Origin matches the loopback host on the listening port → allow.
//     (production, when the client is served from the same origin)
//   * Origin matches the Vite dev server on loopback → allow.
//   * Origin appears in app.json `allowedOrigins` → allow.
//   * Anything else → 403.
const DEV_ORIGINS = new Set<string>([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

const configuredOrigins = new Set<string>(appConfig.allowedOrigins);

function isAllowedOrigin(origin: string): boolean {
  if (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
  ) {
    return true;
  }
  if (DEV_ORIGINS.has(origin)) return true;
  return configuredOrigins.has(origin);
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

app.use((req, res, next) => {
  const requestId = `req-${nextRequestId++}`;
  const startedAt = Date.now();
  let finished = false;

  res.locals.requestId = requestId;

  info(
    `Request started: id=${requestId}, method=${req.method}, path=${req.originalUrl}, ` +
      `contentType=${req.headers["content-type"] ?? "-"}, origin=${req.headers.origin ?? "-"}, ` +
      `queryKeys=${formatRequestShape(req.query)}, bodyKeys=${formatRequestShape(req.body)}`
  );

  res.on("finish", () => {
    finished = true;
    const durationMs = Date.now() - startedAt;
    info(
      `Request finished: id=${requestId}, status=${res.statusCode}, durationMs=${durationMs}, ` +
        `workspace=${res.locals.workspaceId ?? "-"}, responseBytes=${res.getHeader("content-length") ?? "-"}`
    );
  });

  res.on("close", () => {
    if (finished) return;
    const durationMs = Date.now() - startedAt;
    warn(
      `Request closed early: id=${requestId}, method=${req.method}, path=${req.originalUrl}, ` +
        `durationMs=${durationMs}, workspace=${res.locals.workspaceId ?? "-"}`
    );
  });

  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Workspace management (no workspace prefix)
app.use("/api/logs", logsRouter);
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
app.use("/api/w/:wsId/imaging", imagingRouter);
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

process.on("unhandledRejection", (reason) => {
  logError(`Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

process.on("uncaughtException", (err) => {
  logError(`Uncaught exception: ${err.stack ?? err.message}`);
});

app.listen(port, host, () => {
  info(`Server started on ${host}:${port}, ${appConfig.workspaces.length} workspace(s) configured`);

  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback) {
    info(
      `Listening on a non-loopback address (${host}). The server is reachable from other devices on the same network. ` +
      `There is no authentication; rely on your network's firewall and on app.json "allowedOrigins" to control access.`
    );
    if (configuredOrigins.size === 0) {
      info(
        `Note: no "allowedOrigins" are configured. Browsers reaching the server from a non-loopback hostname ` +
        `(e.g. http://${host}:${port}) will be rejected by the Origin guard until you add that URL to "allowedOrigins" in app.json.`
      );
    }
  }
});
