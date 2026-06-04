import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "../../src/services/dataDir.js";
import { saveTargets } from "../../src/services/configStore.js";
import { clearCache } from "../../src/services/postStore.js";
import { postsRouter } from "../../src/../src/routes/posts.js";

let dataDir: string;

// Mounts the real router behind the same res.locals.dataDir contract that
// resolveWorkspace provides in production, plus a minimal error handler.
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.dataDir = dataDir;
    next();
  });
  app.use("/", postsRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-posts-route-"));
  initializeWorkspaceData(dataDir);
  // A post can only be created against a configured target.
  saveTargets(dataDir, [
    { name: "blogger", defaultLanguage: "en", requiresMetadata: true },
  ]);
});

afterEach(() => {
  clearCache(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function createDraft(app: express.Express): Promise<string> {
  const res = await request(app)
    .post("/")
    .send({ target: "blogger", language: "en" });
  expect(res.status).toBe(201);
  return res.body.frontMatter.id;
}

describe("GET /", () => {
  it("returns empty lists for a fresh workspace", async () => {
    const res = await request(makeApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      drafts: [],
      ready: [],
      published: [],
      publishedTotal: 0,
    });
  });
});

describe("POST /", () => {
  it("creates a draft for a valid target and language", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/")
      .send({ target: "blogger", language: "en" });
    expect(res.status).toBe(201);
    expect(res.body.frontMatter.status).toBe("draft");
    expect(res.body.frontMatter.target).toBe("blogger");
  });

  it("rejects a missing target/language with 400", async () => {
    const res = await request(makeApp()).post("/").send({ language: "en" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown target with 400", async () => {
    const res = await request(makeApp())
      .post("/")
      .send({ target: "ghost", language: "en" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown target/i);
  });

  it("rejects an unsupported language with 400", async () => {
    const res = await request(makeApp())
      .post("/")
      .send({ target: "blogger", language: "zz" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported language/i);
  });
});

describe("GET /:id", () => {
  it("returns a created post and 404 for an unknown id", async () => {
    const app = makeApp();
    const id = await createDraft(app);

    const ok = await request(app).get(`/${id}`);
    expect(ok.status).toBe(200);
    expect(ok.body.frontMatter.id).toBe(id);

    const missing = await request(app).get("/nope");
    expect(missing.status).toBe(404);
  });
});

describe("PUT /:id", () => {
  it("updates content", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    const res = await request(app)
      .put(`/${id}`)
      .send({ content: "Hello body." });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("Hello body.");
  });

  it("rejects updates to reserved front matter fields with 400", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    const res = await request(app)
      .put(`/${id}`)
      .send({ frontMatter: { status: "published" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reserved/i);
  });

  it("rejects a path-traversing slug with 400", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    const res = await request(app)
      .put(`/${id}`)
      .send({ frontMatter: { slug: "../escape" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid slug/i);
  });
});

describe("PUT /:id/status", () => {
  it("rejects an invalid status value with 400", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    const res = await request(app).put(`/${id}/status`).send({ status: "archived" });
    expect(res.status).toBe(400);
  });

  it("refuses to promote to ready without a slug (400)", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    const res = await request(app).put(`/${id}/status`).send({ status: "ready" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/slug/i);
  });

  it("promotes a draft to ready once a slug is set", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    await request(app).put(`/${id}`).send({ frontMatter: { slug: "my-post" } });

    const res = await request(app).put(`/${id}/status`).send({ status: "ready" });
    expect(res.status).toBe(200);
    expect(res.body.frontMatter.status).toBe("ready");
    expect(res.body.frontMatter.readyAtUtc).toBeTruthy();
  });
});

describe("DELETE /:id", () => {
  it("deletes a post and then returns 404", async () => {
    const app = makeApp();
    const id = await createDraft(app);

    const del = await request(app).delete(`/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const again = await request(app).delete(`/${id}`);
    expect(again.status).toBe(404);
  });
});
