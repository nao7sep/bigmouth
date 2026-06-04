import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "../../src/services/dataDir.js";
import { createPost, clearCache, getPost } from "../../src/services/postStore.js";
import { targetsRouter } from "../../src/../src/routes/targets.js";

let dataDir: string;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.dataDir = dataDir;
    next();
  });
  app.use("/", targetsRouter);
  return app;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-targets-route-"));
  initializeWorkspaceData(dataDir);
});

afterEach(() => {
  clearCache(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("GET / and PUT /", () => {
  it("starts empty and persists saved targets", async () => {
    const app = makeApp();
    expect((await request(app).get("/")).body).toEqual([]);

    const saved = await request(app)
      .put("/")
      .send([{ name: "blogger", defaultLanguage: "en", requiresMetadata: true }]);
    expect(saved.status).toBe(200);
    expect(saved.body).toHaveLength(1);
    expect(saved.body[0].name).toBe("blogger");

    expect((await request(app).get("/")).body[0].name).toBe("blogger");
  });
});

describe("PUT /rename", () => {
  it("validates input", async () => {
    const res = await request(makeApp()).put("/rename").send({ oldName: "" });
    expect(res.status).toBe(400);
  });

  it("404s when the target does not exist", async () => {
    const res = await request(makeApp())
      .put("/rename")
      .send({ oldName: "ghost", newName: "x" });
    expect(res.status).toBe(404);
  });

  it("renames a target and rewrites the target on existing posts", async () => {
    const app = makeApp();
    await request(app)
      .put("/")
      .send([{ name: "blogger", defaultLanguage: "en", requiresMetadata: true }]);
    const post = createPost(dataDir, "blogger", "en");

    const res = await request(app)
      .put("/rename")
      .send({ oldName: "blogger", newName: "personal-blog" });

    expect(res.status).toBe(200);
    expect(res.body.postsUpdated).toBe(1);
    expect(res.body.targets[0].name).toBe("personal-blog");
    expect(getPost(dataDir, post.frontMatter.id)?.frontMatter.target).toBe(
      "personal-blog"
    );
  });

  it("rejects renaming to an existing name with 400", async () => {
    const app = makeApp();
    await request(app)
      .put("/")
      .send([
        { name: "blogger", defaultLanguage: "en", requiresMetadata: true },
        { name: "personal", defaultLanguage: "en", requiresMetadata: false },
      ]);

    const res = await request(app)
      .put("/rename")
      .send({ oldName: "blogger", newName: "personal" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/i);
  });
});
