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

async function publish(app: express.Express, id: string): Promise<void> {
  await request(app).put(`/${id}`).send({ frontMatter: { slug: "my-post" } });
  const res = await request(app).put(`/${id}/status`).send({ status: "published" });
  expect(res.status).toBe(200);
  expect(res.body.frontMatter.status).toBe("published");
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
      expired: [],
      expiredTotal: 0,
    });
  });

  it("clamps a negative offset to the first page instead of slicing from the end", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    await request(app).put(`/${id}/status`).send({ status: "expired" });

    const res = await request(app).get("/?expiredOffset=-5&publishedOffset=-5");
    expect(res.status).toBe(200);
    expect(res.body.expiredOffset).toBe(0);
    expect(res.body.publishedOffset).toBe(0);
    expect(res.body.expired.map((p: { frontMatter: { id: string } }) => p.frontMatter.id)).toContain(id);
  });

  it("returns an expired post in the expired list with its total/offset", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    const moved = await request(app).put(`/${id}/status`).send({ status: "expired" });
    expect(moved.status).toBe(200);
    expect(moved.body.frontMatter.status).toBe("expired");
    expect(moved.body.frontMatter.expiredAtUtc).toBeTruthy();

    const list = await request(app).get("/");
    expect(list.body.expiredTotal).toBe(1);
    expect(list.body.expiredOffset).toBe(0);
    expect(list.body.expired.map((p: { frontMatter: { id: string } }) => p.frontMatter.id)).toContain(id);
    expect(list.body.published).toHaveLength(0);
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

describe("source linking", () => {
  it("creates a post linked to an existing source and exposes it via the index", async () => {
    const app = makeApp();
    const sourceId = await createDraft(app);
    const res = await request(app)
      .post("/")
      .send({ target: "blogger", language: "en", sourceId });
    expect(res.status).toBe(201);
    expect(res.body.frontMatter.sourceId).toBe(sourceId);

    // The index summary must carry sourceId so the list/picker can show the link.
    const list = await request(app).get("/");
    const summary = list.body.drafts.find(
      (p: { frontMatter: { id: string } }) => p.frontMatter.id === res.body.frontMatter.id
    );
    expect(summary.frontMatter.sourceId).toBe(sourceId);
  });

  it("rejects creating a post with a non-existent source (400)", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/")
      .send({ target: "blogger", language: "en", sourceId: "ghost-id" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source post not found/i);
  });

  it("sets and clears the source through PUT", async () => {
    const app = makeApp();
    const sourceId = await createDraft(app);
    const id = await createDraft(app);

    const linked = await request(app).put(`/${id}`).send({ frontMatter: { sourceId } });
    expect(linked.status).toBe(200);
    expect(linked.body.frontMatter.sourceId).toBe(sourceId);

    const cleared = await request(app).put(`/${id}`).send({ frontMatter: { sourceId: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.frontMatter.sourceId).toBeUndefined();
  });

  it("clears the referrer's sourceId when the source is deleted (cascade), and the source 404s", async () => {
    const app = makeApp();
    const sourceId = await createDraft(app);
    const child = await request(app)
      .post("/")
      .send({ target: "blogger", language: "en", sourceId });
    const childId = child.body.frontMatter.id;

    await request(app).delete(`/${sourceId}`);

    const referrer = await request(app).get(`/${childId}`);
    expect(referrer.status).toBe(200);
    expect(referrer.body.frontMatter.sourceId).toBeUndefined();
    const goneSource = await request(app).get(`/${sourceId}`);
    expect(goneSource.status).toBe(404);
  });

  it("rejects setting a post as its own source via PUT (400)", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    const res = await request(app).put(`/${id}`).send({ frontMatter: { sourceId: id } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own source/i);
  });

  it("rejects setting a non-existent source via PUT (400)", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    const res = await request(app).put(`/${id}`).send({ frontMatter: { sourceId: "ghost" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source post not found/i);
  });

  it("reports referrers via GET /:id/referrers", async () => {
    const app = makeApp();
    const sourceId = await createDraft(app);
    await request(app).post("/").send({ target: "blogger", language: "en", sourceId });

    const res = await request(app).get(`/${sourceId}/referrers`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.ids).toHaveLength(1);
  });
});

describe("published lock", () => {
  it("rejects content edits to a published post with 409", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    await publish(app, id);

    const res = await request(app).put(`/${id}`).send({ content: "Sneaky edit." });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/locked/i);
  });

  it("allows editing again after moving back to ready", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    await publish(app, id);

    const back = await request(app).put(`/${id}/status`).send({ status: "ready" });
    expect(back.status).toBe(200);

    const res = await request(app).put(`/${id}`).send({ content: "Now editable." });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("Now editable.");
  });

  it("still allows deleting a published post", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    await publish(app, id);

    const del = await request(app).delete(`/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
  });

  it("rejects content edits to an expired post with 409", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    await request(app).put(`/${id}/status`).send({ status: "expired" });

    const res = await request(app).put(`/${id}`).send({ content: "Sneaky edit." });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/expired posts are locked/i);
  });
});

describe("PUT /:id/status", () => {
  it("rejects an invalid status value with 400", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    const res = await request(app).put(`/${id}/status`).send({ status: "archived" });
    expect(res.status).toBe(400);
  });

  it("promotes a draft to ready without requiring a slug", async () => {
    const app = makeApp();
    const id = await createDraft(app);

    const res = await request(app).put(`/${id}/status`).send({ status: "ready" });
    expect(res.status).toBe(200);
    expect(res.body.frontMatter.status).toBe("ready");
    expect(res.body.frontMatter.readyAtUtc).toBeTruthy();
    expect(res.body.frontMatter.slug).toBeUndefined();
  });
});

describe("POST /index/rebuild", () => {
  it("rebuilds the index and reports the post count", async () => {
    const app = makeApp();
    await createDraft(app);
    await createDraft(app);

    const res = await request(app).post("/index/rebuild");
    expect(res.status).toBe(200);
    expect(res.body.rebuilt).toBe(true);
    expect(res.body.count).toBe(2);
  });
});

describe("mutation response summary", () => {
  it("returns the canonical summary with a derived excerpt on update", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    const res = await request(app).put(`/${id}`).send({ content: "A first body line for the label." });
    expect(res.status).toBe(200);
    expect(res.body.summary?.id).toBe(id);
    expect(res.body.summary.excerpt).toBe("A first body line for the label.");
  });

  it("omits the excerpt from the summary once a title is set", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    await request(app).put(`/${id}`).send({ content: "Body." });
    const res = await request(app).put(`/${id}`).send({ frontMatter: { title: "T" } });
    expect(res.body.summary.title).toBe("T");
    expect(res.body.summary.excerpt).toBeUndefined();
  });

  it("returns a summary on status change", async () => {
    const app = makeApp();
    const id = await createDraft(app);
    const res = await request(app).put(`/${id}/status`).send({ status: "ready" });
    expect(res.body.summary?.status).toBe("ready");
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
