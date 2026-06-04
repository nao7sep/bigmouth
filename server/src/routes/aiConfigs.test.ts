import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "../services/dataDir.js";
import { aiConfigsRouter } from "./aiConfigs.js";

let dataDir: string;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.dataDir = dataDir;
    next();
  });
  app.use("/", aiConfigsRouter);
  return app;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-aiconfigs-route-"));
  initializeWorkspaceData(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /", () => {
  it("returns configs without exposing any API key", async () => {
    const res = await request(makeApp()).get("/");
    expect(res.status).toBe(200);
    for (const config of res.body.configs) {
      expect(config.apiKey).toBe("");
      expect(config).toHaveProperty("hasApiKey");
    }
  });
});

describe("POST /", () => {
  it("creates a config and never echoes the plaintext key", async () => {
    const app = makeApp();
    const res = await request(app).post("/").send({
      id: "c1",
      name: "Claude",
      provider: "claude",
      model: "claude-opus-4-8",
      apiKey: "sk-ant-secret",
    });
    expect(res.status).toBe(201);

    const created = res.body.configs.find((c: { id: string }) => c.id === "c1");
    expect(created.apiKey).toBe("");
    expect(created.hasApiKey).toBe(true);

    // The plaintext key must never appear anywhere in the HTTP response.
    expect(JSON.stringify(res.body)).not.toContain("sk-ant-secret");
  });

  it("rejects a malformed id with 400", async () => {
    const res = await request(makeApp()).post("/").send({
      id: "bad id!",
      name: "X",
      provider: "claude",
      model: "m",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown provider with 400", async () => {
    const res = await request(makeApp()).post("/").send({
      id: "c1",
      name: "X",
      provider: "openai",
      model: "m",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider/i);
  });

  it("rejects a duplicate id with 400", async () => {
    const app = makeApp();
    const body = { id: "c1", name: "X", provider: "claude", model: "m" };
    await request(app).post("/").send(body);
    const res = await request(app).post("/").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/i);
  });
});

describe("PUT /active and DELETE /:id", () => {
  it("sets an active config then refuses to delete it (400)", async () => {
    const app = makeApp();
    await request(app)
      .post("/")
      .send({ id: "c1", name: "X", provider: "claude", model: "m" });

    const active = await request(app).put("/active").send({ id: "c1" });
    expect(active.status).toBe(200);
    expect(active.body.activeId).toBe("c1");

    const del = await request(app).delete("/c1");
    expect(del.status).toBe(400);
    expect(del.body.error).toMatch(/active/i);
  });

  it("rejects activating a config that does not exist with 400", async () => {
    const res = await request(makeApp()).put("/active").send({ id: "ghost" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });
});
