import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { initAppDir, getLogsDir } from "./services/workspaceStore.js";
import {
  initLogger,
  closeLogger,
  info,
  warn,
  error as logError,
  serializeError,
  getCurrentLogFilePath,
  isDebugLoggingEnabled,
} from "./services/logger.js";
import { DEFAULT_HOST, DEFAULT_PORT, MAX_REQUEST_BODY_BYTES } from "./shared/defaults.js";
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
import { metadataRouter } from "./routes/metadata.js";
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
  "http://127.0.0.1:5273",
  "http://localhost:5273",
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

app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES }));

// Summarizes a request's query/body for logging by shape only — the field NAMES
// for a plain object, a length for an array, a type tag otherwise. Never the
// values, so a logged request can carry no secret.
function bodyShape(value: unknown): string[] | string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>);
  return typeof value;
}

app.use((req, res, next) => {
  const requestId = `req-${nextRequestId++}`;
  const startedAt = Date.now();
  let finished = false;

  res.locals.requestId = requestId;

  info("request started", {
    requestId,
    method: req.method,
    path: req.originalUrl,
    contentType: req.headers["content-type"] ?? null,
    origin: req.headers.origin ?? null,
    queryKeys: bodyShape(req.query),
    bodyKeys: bodyShape(req.body),
  });

  res.on("finish", () => {
    finished = true;
    info("request finished", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      bytes: res.getHeader("content-length") ?? null,
      workspace: res.locals.workspaceId ?? null,
    });
  });

  res.on("close", () => {
    if (finished) return;
    warn("request closed early", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      durationMs: Date.now() - startedAt,
      workspace: res.locals.workspaceId ?? null,
    });
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
app.use("/api/w/:wsId/metadata", metadataRouter);
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
  // body-parser tags PayloadTooLargeError with `type === "entity.too.large"`.
  // Surface it as 413 with a clear message instead of a generic 500 — autosave
  // and other content-bearing routes can then show "request too large" rather
  // than "internal server error".
  if ((err as Error & { type?: string }).type === "entity.too.large") {
    warn("request body too large", {
      requestId: res.locals.requestId ?? null,
      limitBytes: MAX_REQUEST_BODY_BYTES,
      error: serializeError(err),
    });
    res.status(413).json({ error: "Request body is larger than the server limit." });
    return;
  }
  logError("unhandled request error", {
    requestId: res.locals.requestId ?? null,
    error: serializeError(err),
  });
  res.status(500).json({ error: "Internal server error" });
});

process.on("unhandledRejection", (reason) => {
  logError("unhandled promise rejection", { error: serializeError(reason) });
});

process.on("uncaughtException", (err) => {
  // The process state is unknown after an uncaught exception: log it with full
  // fidelity, flush by closing the file, then exit non-zero rather than limp on.
  logError("uncaught exception", { error: serializeError(err) });
  closeLogger();
  process.exit(1);
});

// Clean-shutdown logging: record the signal, close the log file, then exit.
function shutdown(signal: NodeJS.Signals): void {
  info("server shutting down", { reason: "signal", signal });
  closeLogger();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// "Is this binding inaccessible from outside this machine?" — true for the
// full 127.0.0.0/8 IPv4 loopback range, the IPv6 loopback ::1, and the
// "localhost" alias. Anything else (0.0.0.0, ::, an interface IP) is treated
// as LAN-exposed and triggers the startup warning.
function isLoopbackHost(value: string): boolean {
  if (value === "localhost") return true;
  const kind = net.isIP(value);
  if (kind === 4) return value.startsWith("127.");
  if (kind === 6) return value === "::1";
  return false;
}

app.listen(port, host, () => {
  info("server started", {
    version: readServerVersion(),
    host,
    port,
    workspaceCount: appConfig.workspaces.length,
    allowedOrigins: appConfig.allowedOrigins,
    debug: isDebugLoggingEnabled(),
    logFile: getCurrentLogFilePath(),
  });

  if (!isLoopbackHost(host)) {
    warn("listening on a non-loopback address", {
      host,
      port,
      allowedOriginsConfigured: configuredOrigins.size,
      note:
        "The server is reachable from other devices on the same network and has no authentication; " +
        'rely on your firewall and on app.json "allowedOrigins" to control access.',
    });
    if (configuredOrigins.size === 0) {
      warn("no allowedOrigins configured while exposed", {
        host,
        port,
        note:
          `Browsers reaching the server from a non-loopback hostname (e.g. http://${host}:${port}) will be ` +
          'rejected by the Origin guard until that URL is added to "allowedOrigins" in app.json.',
      });
    }
  }
});

/** Reads this server's version from package.json for the startup record. */
function readServerVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "../package.json");
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}
