import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "../../src/services/dataDir.js";
import { settingsRouter } from "../../src/../src/routes/settings.js";

let dataDir: string;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.dataDir = dataDir;
    next();
  });
  app.use("/", settingsRouter);
  return app;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-settings-route-"));
  initializeWorkspaceData(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /", () => {
  it("returns the seeded default settings", async () => {
    const res = await request(makeApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("Asia/Tokyo");
    expect(Array.isArray(res.body.supportedLanguages)).toBe(true);
  });
});

describe("PUT /", () => {
  it("saves settings and normalizes supportedLanguages (de-duplicated, sorted)", async () => {
    const app = makeApp();
    const current = (await request(app).get("/")).body;

    const res = await request(app)
      .put("/")
      .send({ ...current, supportedLanguages: ["ja", "en", "ja", "es"] });

    expect(res.status).toBe(200);
    expect(res.body.supportedLanguages).toEqual(["en", "es", "ja"]);

    // Persisted: a fresh GET reflects the normalized value.
    const reread = await request(app).get("/");
    expect(reread.body.supportedLanguages).toEqual(["en", "es", "ja"]);
  });
});
