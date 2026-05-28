import { Router } from "express";
import {
  getAiConfigsForClient,
  createAiConfig,
  updateAiConfig,
  deleteAiConfig,
  setActiveAiConfig,
  type UpdateAiConfigPatch,
} from "../services/configStore.js";
import { AI_PROVIDERS, type AiProvider } from "../shared/types.js";
import * as logger from "../services/logger.js";

export const aiConfigsRouter = Router({ mergeParams: true });

// AI config IDs use the same alphabet as nanoid. They are stored as the keys
// for individual configs inside ai-configs.json and never reach the
// filesystem, but rejecting odd characters keeps URLs and logs sane.
const ID_RE = /^[A-Za-z0-9_-]+$/;

function isAiProvider(value: unknown): value is AiProvider {
  return (
    typeof value === "string" &&
    (AI_PROVIDERS as readonly string[]).includes(value)
  );
}

// --- GET / ---

aiConfigsRouter.get("/", (_req, res) => {
  const dataDir = res.locals.dataDir as string;
  const configs = getAiConfigsForClient(dataDir);
  logger.info(
    `AI configs loaded: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, configCount=${configs.configs.length}, activeId=${configs.activeId}`
  );
  res.json(configs);
});

// --- POST / ---
//
// Create one AI config with a caller-supplied id. Returns the full updated
// AiConfigsData so the client can resync state in one round trip.

aiConfigsRouter.post("/", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const body = req.body as {
    id?: unknown;
    name?: unknown;
    provider?: unknown;
    model?: unknown;
    apiKey?: unknown;
  };

  if (typeof body.id !== "string" || !ID_RE.test(body.id)) {
    res.status(400).json({ error: "id is required and must match [A-Za-z0-9_-]+" });
    return;
  }
  if (typeof body.name !== "string") {
    res.status(400).json({ error: "name must be a string" });
    return;
  }
  if (!isAiProvider(body.provider)) {
    res.status(400).json({ error: `provider must be one of: ${AI_PROVIDERS.join(", ")}` });
    return;
  }
  if (typeof body.model !== "string") {
    res.status(400).json({ error: "model must be a string" });
    return;
  }
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
    res.status(400).json({ error: "apiKey must be a string" });
    return;
  }

  try {
    const result = createAiConfig(dataDir, {
      id: body.id,
      name: body.name,
      provider: body.provider,
      model: body.model,
      apiKey: body.apiKey,
    });
    logger.info(
      `AI config created: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, id=${body.id}`
    );
    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create AI config";
    logger.warn(
      `AI config create failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, id=${body.id}, message=${message}`
    );
    res.status(400).json({ error: message });
  }
});

// --- PUT /active ---
//
// Set the currently active config. Mounted before PUT /:id so it isn't
// captured by the parameter route.

aiConfigsRouter.put("/active", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const body = req.body as { id?: unknown };

  if (typeof body.id !== "string") {
    res.status(400).json({ error: "id must be a string" });
    return;
  }
  if (body.id !== "" && !ID_RE.test(body.id)) {
    res.status(400).json({ error: "id is malformed" });
    return;
  }

  try {
    const result = setActiveAiConfig(dataDir, body.id);
    logger.info(
      `AI active config set: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, activeId=${body.id || "-"}`
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to set active AI config";
    logger.warn(
      `AI active config set failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, id=${body.id}, message=${message}`
    );
    res.status(400).json({ error: message });
  }
});

// --- PUT /:id ---
//
// Partial update. Field semantics:
//   - field omitted from body  → preserve existing value
//   - apiKey: ""               → clear the stored key
//   - apiKey: "..."            → replace the stored key

aiConfigsRouter.put("/:id", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const id = req.params.id;

  if (!ID_RE.test(id)) {
    res.status(400).json({ error: "id is malformed" });
    return;
  }

  const body = req.body as {
    name?: unknown;
    provider?: unknown;
    model?: unknown;
    apiKey?: unknown;
  };

  const patch: UpdateAiConfigPatch = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      res.status(400).json({ error: "name must be a string" });
      return;
    }
    patch.name = body.name;
  }
  if (body.provider !== undefined) {
    if (!isAiProvider(body.provider)) {
      res.status(400).json({ error: `provider must be one of: ${AI_PROVIDERS.join(", ")}` });
      return;
    }
    patch.provider = body.provider;
  }
  if (body.model !== undefined) {
    if (typeof body.model !== "string") {
      res.status(400).json({ error: "model must be a string" });
      return;
    }
    patch.model = body.model;
  }
  if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== "string") {
      res.status(400).json({ error: "apiKey must be a string" });
      return;
    }
    patch.apiKey = body.apiKey;
  }

  try {
    const result = updateAiConfig(dataDir, id, patch);
    const changed = Object.keys(patch).join(",") || "-";
    logger.info(
      `AI config updated: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, id=${id}, changed=${changed}`
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update AI config";
    logger.warn(
      `AI config update failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, id=${id}, message=${message}`
    );
    res.status(400).json({ error: message });
  }
});

// --- DELETE /:id ---
//
// Refuses to delete the active config. Caller must reassign active first.

aiConfigsRouter.delete("/:id", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const id = req.params.id;

  if (!ID_RE.test(id)) {
    res.status(400).json({ error: "id is malformed" });
    return;
  }

  try {
    const result = deleteAiConfig(dataDir, id);
    logger.info(
      `AI config deleted: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, id=${id}`
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete AI config";
    logger.warn(
      `AI config delete failed: requestId=${res.locals.requestId ?? "-"}, workspace=${res.locals.workspaceId ?? "-"}, id=${id}, message=${message}`
    );
    res.status(400).json({ error: message });
  }
});
