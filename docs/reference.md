# bigmouth — Reference

bigmouth is a **local-first HTTP API service** (an Express server) with a **single-page React client**. The stable contract documented here is the server's HTTP API under `/api`. The browser client's `client/src/api.ts` is a thin binding layer over these endpoints — each client function maps to exactly one route — so this document describes each operation once at the HTTP level and notes the client binding only where its behavior (timeouts, stream framing) adds something the route does not state.

The service manages writing "preflight": Markdown posts move through a `draft → checked → published` lifecycle, carry editable front matter (title, slug, tags, meta description, plus English supplements), can have binary assets attached, and can be run through Claude-backed AI operations (editorial analysis, metadata generation, image-prompt generation). All persistent state lives on disk per workspace.

## Conventions

- **Base URL.** Everything is under `/api`. Workspace-scoped routes are under `/api/w/:wsId/...`; workspace management and logs are under `/api/workspaces` and `/api/logs` with no `:wsId`.
- **Content type.** Request and response bodies are JSON (`application/json`) unless noted. The asset upload is `multipart/form-data`; the raw asset download and the analysis stream return non-JSON bodies.
- **Errors.** Failures return a JSON body of the shape `{ "error": string }` with a non-2xx status. The `error` string is human-readable and is what the client surfaces directly. There are no machine-readable error codes — clients branch on the HTTP status.
- **Request body limit.** JSON bodies are capped at 50 MB (`MAX_REQUEST_BODY_BYTES`). Exceeding it returns `413 { "error": "Request body is larger than the server limit." }`. Asset uploads use a separate, per-workspace multipart limit (see Assets).
- **Unhandled errors** return `500 { "error": "Internal server error" }`.

## Authentication and access control

**There is no authentication.** Any client that can reach the server has full access to every workspace. Access is controlled by two mechanisms only:

- **Bind address.** The server binds to `127.0.0.1:3141` by default (loopback-only). The host/port come from `~/.bigmouth/app.json` (`host`, `port`). Binding to a non-loopback address (e.g. `0.0.0.0`) exposes the unauthenticated API to the LAN; the server logs a startup warning when it does.
- **Origin guard (CSRF).** A global middleware inspects the `Origin` request header. Requests with no `Origin` (same-origin GETs, curl, server-to-server) are allowed. Requests whose `Origin` is a loopback host on the listening port, the Vite dev origin, or an entry in `app.json` `allowedOrigins` are allowed. Anything else gets `403 { "error": "Forbidden origin" }`. This guard runs before routing, so any endpoint can return 403 on a disallowed cross-origin browser request.

There are no API keys, tokens, sessions, or cookies on the HTTP surface. (Provider API keys for Claude are a separate concept — stored server-side per workspace, never returned to clients; see AI configs.)

## Workspace resolution

Every `/api/w/:wsId/...` route first runs `resolveWorkspace`, which looks up `:wsId` in the registry. Therefore all workspace-scoped endpoints below additionally return:

- `400 { "error": "Workspace ID is required" }` — `:wsId` empty.
- `404 { "error": "Workspace not found" }` — `:wsId` does not match a registered workspace.

These two are not repeated per endpoint.

## Persisted artifacts

State lives in two places on disk:

- **App registry:** `~/.bigmouth/app.json` holds `{ port, host, allowedOrigins, workspaces[] }`. Logs are written under `~/.bigmouth/logs/`. Default new-workspace folders are created under `~/.bigmouth/workspaces/<id>/`.
- **Per-workspace data directory** (an absolute path recorded in the registry; may be anywhere, including a git-versioned folder). A valid workspace directory contains: `settings.json`, `ai-configs.json`, `targets.json`, `analysis-prompts.json`, `generation-prompts.json`, a `posts/` directory (one `.md` file per post, plus a derived `index.json`), and an `assets/` directory (`assets/<postId>/<filename>` plus a derived `meta.json` sidecar). The `.md` files and the asset files are the source of truth; `index.json` and `meta.json` are caches that self-heal on read and can be rebuilt.

---

## Health

### `GET /api/health`

Liveness probe. No workspace, no auth.

- **Response 200:** `{ "status": "ok" }`.

---

## Logs

The server keeps a current log file under `~/.bigmouth/logs/`. These endpoints are not workspace-scoped.

### `GET /api/logs/current`

Returns the path of the active log file.

- **Response 200:** `{ "path": string }` — absolute path to the current log file.
- **404** `{ "error": "Current log file is not available" }` — logging is not file-backed.

### `POST /api/logs/current/reveal`

Reveals the current log file in the OS file manager (a side effect on the host). No request body.

- **Response 200:** `{ "path": string }`.
- **404** if there is no current log file (same condition as above); **500** `{ "error": <message> }` if the reveal operation fails.

---

## Workspaces

Workspace management. Not workspace-scoped (these manage the workspaces themselves). A `Workspace` is `{ id: string, name: string, dataDirectory: string }` (an absolute, home-expanded path).

### `GET /api/workspaces`

List all registered workspaces.

- **Response 200:** `Workspace[]`.

### `GET /api/workspaces/:id`

Get one workspace.

- **Response 200:** `Workspace`.
- **404** `{ "error": "Workspace not found" }`.

### `POST /api/workspaces/open-or-create`

Open an existing bigmouth workspace folder, or create a new one. The single entry point used by the client for both. Body `{ name?: string, dataDirectory?: string }` (both trimmed):

- No `dataDirectory` → creates a new workspace in a fresh default folder under `~/.bigmouth/workspaces/<id>/`. `name` defaults to `"Workspace"`, `"Workspace 2"`, … if omitted.
- `dataDirectory` already registered → returns the existing workspace (idempotent open).
- `dataDirectory` exists and contains a valid workspace → opens it (registers a new id pointing at it).
- `dataDirectory` exists and is an empty directory → creates a new workspace there.
- **Response 201:** `Workspace` (note: returns 201 even when opening/returning an existing workspace).
- **400** `{ "error": <message> }` — the path is a non-directory (`"Location must be a directory."`), or exists, is non-empty, and is not a workspace (`"Location must be empty or already contain a bigmouth workspace."`). The message is whatever the store threw.

### `PUT /api/workspaces/:id`

Update a workspace's `name` and/or `dataDirectory`. Body `{ name?: string, dataDirectory?: string }` (trimmed; only provided fields change). Changing `dataDirectory` requires the new path to be empty or already a workspace, and not already registered to another workspace.

- **Response 200:** the updated `Workspace`.
- **404** `{ "error": "Workspace not found" }`.
- **400** `{ "error": <message> }` — e.g. folder already registered to another workspace, or `"Workspace location must be an empty folder or an existing workspace."`.

### `DELETE /api/workspaces/:id`

Remove a workspace from the registry. **Does not delete data on disk** — the folder and its files remain; only the registry entry is dropped (and the in-memory post-index cache for that folder is evicted).

- **Response 200:** `{ "deleted": true }`.
- **404** `{ "error": "Workspace not found" }`.

---

## Posts

All routes below are under `/api/w/:wsId/posts`. A post on the wire is `{ frontMatter: PostFrontMatter, content: string }`; `content` is the raw Markdown body. Mutation responses additionally carry `summary` (the list projection, including a derived `excerpt`) so the client can update its lists without a refetch.

`PostFrontMatter` fields: `id` (nanoid, immutable), `target`, `status` (`draft`|`checked`|`published`), `language` (two-letter code), and the optional editable fields `sourceId`, `title`, `titleEn`, `slug`, `tags[]`, `tagsEn[]`, `metaDescription`, `metaDescriptionEn`, `extra`, plus the server-managed timestamps `createdAtUtc` (immutable, ISO 8601), `updatedAtUtc`, `checkedAtUtc?`, `publishedAtUtc?`. `*En` supplement fields are conventionally omitted when `language` is `"en"`.

### `GET /api/w/:wsId/posts`

List posts grouped by status. Drafts and checked are returned in full (sorted newest-created first); published is paginated.

- **Query:** `publishedOffset` (integer, default `0`), `limit` (integer, default = the workspace's `settings.publishedPostsPerLoad`, normally 50). Non-numeric values fall back to the defaults.
- **Response 200:** `{ drafts: PostSummary[], checked: PostSummary[], published: PostSummary[], publishedTotal: number, publishedOffset: number }`. A `PostSummary` is `{ frontMatter: PostIndexEntry }` — a projection that omits `content`, `updatedAtUtc`, and the long metadata fields, and adds `fileName` and a body-derived `excerpt` (present only when both `title` and `titleEn` are absent).

### `POST /api/w/:wsId/posts`

Create a draft post. Body:

- `target` (string, **required**, trimmed, must match a configured target name).
- `language` (string, **required**, trimmed, must be in `settings.supportedLanguages`).
- `sourceId` (string, optional — nanoid of an existing post this derives from; must exist).
- New posts always start as `draft` with empty `content`.
- **Response 201:** `{ frontMatter, content: "" }`.
- **400** `{ "error": "target and language are required" }`; `{ "error": "sourceId must be a string" }`; `{ "error": "No targets configured. Add a target in Settings before creating a post." }`; `{ "error": "Unknown target: <name>" }`; `{ "error": "Unsupported language: <code>" }`; `{ "error": "Source post not found" }`.

### `GET /api/w/:wsId/posts/:id`

Get one post with full body.

- **Response 200:** `{ frontMatter, content }`.
- **404** `{ "error": "Post not found" }`.

### `GET /api/w/:wsId/posts/:id/referrers`

List the ids of posts that reference this post as their `sourceId`. Used to warn before deletion (delete clears those links).

- **Response 200:** `{ count: number, ids: string[] }`. Returns `{ count: 0, ids: [] }` even for an unknown id (no 404).

### `PUT /api/w/:wsId/posts/:id`

Update a post's content and/or editable front matter. This is the autosave endpoint. Body `{ content?: string, frontMatter?: object }`:

- `content` — when present, replaces the body. When absent, the body is untouched.
- `frontMatter` — when present, must be a plain object. Only the editable keys (`target`, `language`, `title`, `titleEn`, `slug`, `tags`, `tagsEn`, `metaDescription`, `metaDescriptionEn`, `extra`, `sourceId`) are applied; unknown keys are silently ignored. **A `null` value clears that field.**
- Identity and lifecycle keys (`id`, `status`, `createdAtUtc`, `updatedAtUtc`, `checkedAtUtc`, `publishedAtUtc`) are reserved — including any of them in `frontMatter` is rejected.
- `slug`, when set to a non-empty value, must match `^[a-zA-Z0-9_-]+$` (it is used in export filenames and URLs).
- `sourceId`, when set to a non-empty value, must point at a different, existing post.
- Every successful update bumps `updatedAtUtc`. The on-disk filename never changes (it is derived from immutable fields).
- **Response 200:** `{ frontMatter, content, summary }`, where `summary` is the canonical list projection.
- **404** `{ "error": "Post not found" }`.
- **409** `{ "error": "Published posts are locked. Move the post back to Checked or Draft to edit it." }` — published posts are immutable through this endpoint; checked before any field validation.
- **400** for: `"frontMatter must be an object"`; `"Reserved front matter fields cannot be updated here: <keys>"`; `"Invalid slug: only letters, digits, hyphens, and underscores are allowed"`; `"A post cannot be its own source"`; `"Source post not found"`.

### `PUT /api/w/:wsId/posts/:id/status`

Move a post through the lifecycle. Body `{ status: "draft" | "checked" | "published" }`.

Lifecycle timestamp rules (applied automatically): moving **forward** sets `checkedAtUtc`/`publishedAtUtc` only if currently absent; moving back to `draft` **clears both**. So `published → checked → published` (a typo-fix round trip) preserves the original `publishedAtUtc`, while `→ draft` discards it. A no-op transition (same status) returns the post unchanged. There is **no slug-required or metadata-required gate** on publishing in the current code — any status is reachable as long as the post exists.

- **Response 200:** `{ frontMatter, content, summary }`.
- **400** `{ "error": "Invalid status" }` — status not one of the three. (A transition that throws also returns 400 with the thrown message, but the current state machine does not reject valid transitions.)
- **404** `{ "error": "Post not found" }`.

### `DELETE /api/w/:wsId/posts/:id`

Delete a post. Also clears any other post's `sourceId` that pointed at it, and removes the post's entire `assets/<id>/` directory. This bypasses the published lock (system operation, not a user edit).

- **Response 200:** `{ "deleted": true }`.
- **404** `{ "error": "Post not found" }`.

### `POST /api/w/:wsId/posts/index/rebuild`

Rebuild the derived `posts/index.json` from the `.md` files (the source of truth). Use after editing files out of band or if the index looks stale.

- **Response 200:** `{ "rebuilt": true, "count": number }` — number of posts indexed.
- **500** `{ "error": <message> }` on rebuild failure.

---

## Settings

`/api/w/:wsId/settings`. `Settings` = `{ timezone, supportedLanguages[], publishedPostsPerLoad, maxUploadMb, editorWatermark, extraFieldWatermark }`.

### `GET /api/w/:wsId/settings`

- **Response 200:** the `Settings` object.

### `PUT /api/w/:wsId/settings`

Replace settings. **All fields are required and validated** (this is a full replacement, not a patch):

- `timezone` — non-empty string (IANA timezone; not range-validated).
- `supportedLanguages` — array of strings (deduplicated and sorted case-insensitively on save).
- `publishedPostsPerLoad` — positive integer (`>= 1`).
- `maxUploadMb` — positive number (`> 0`), the per-file asset upload cap in MB.
- `editorWatermark`, `extraFieldWatermark` — strings (may be empty).
- **Response 200:** the normalized, saved `Settings`.
- **400** `{ "error": <message> }` naming the first invalid field, e.g. `"timezone must be a non-empty string"`, `"supportedLanguages must be an array of strings"`, `"publishedPostsPerLoad must be a positive integer"`, `"maxUploadMb must be a positive number"`, `"editorWatermark must be a string"`, `"extraFieldWatermark must be a string"`.

---

## Targets

`/api/w/:wsId/targets`. A `Target` = `{ name: string, defaultLanguage: string, requiresMetadata: boolean }`. Targets are publication destinations (e.g. `"blogger"`); a post's `target` must match a target name.

### `GET /api/w/:wsId/targets`

- **Response 200:** `Target[]`.

### `PUT /api/w/:wsId/targets`

Replace the entire targets list. Body: a `Target[]`. Each element must have a non-empty `name`, a string `defaultLanguage`, and a boolean `requiresMetadata`. (No uniqueness check on names here.)

- **Response 200:** the saved `Target[]`.
- **400** `{ "error": <message> }`, e.g. `"targets must be an array"`, `"each target needs a non-empty name"`, `"each target needs a defaultLanguage string"`, `"each target needs a boolean requiresMetadata"`.

### `PUT /api/w/:wsId/targets/rename`

Rename a target and update every post currently using it (the `target` front-matter field is rewritten in place, without bumping `updatedAtUtc`). Body `{ oldName: string, newName: string }` (both trimmed, non-empty).

- **Response 200:** `{ targets: Target[], postsUpdated: number }`.
- **400** `{ "error": "oldName and newName are required" }`; `{ "error": "A target with that name already exists" }`.
- **404** `{ "error": "Target not found" }`.

---

## AI configs

`/api/w/:wsId/ai-configs`. Stores provider credentials per workspace. Only provider `"claude"` exists. An `AiConfig` stored server-side is `{ id, name, provider, model, apiKey }`. **The plaintext API key is never sent to clients** — list/mutation responses return each config with `apiKey: ""` and a boolean `hasApiKey` indicating whether a key is stored. Keys are obfuscated at rest in `ai-configs.json`. IDs must match `^[A-Za-z0-9_-]+$`.

The client-facing data shape (`AiConfigsData`) is `{ activeId: string, configs: AiConfig[] }`, where each `configs` entry is `{ id, name, provider, model, apiKey: "", hasApiKey: boolean }`. All mutating endpoints return the full updated `AiConfigsData` so the client resyncs in one round trip.

### `GET /api/w/:wsId/ai-configs`

- **Response 200:** `AiConfigsData` (keys redacted).

### `POST /api/w/:wsId/ai-configs`

Create a config with a **caller-supplied id**. Body `{ id, name, provider, model, apiKey? }`:

- `id` — required, matches `^[A-Za-z0-9_-]+$`, must not collide with an existing config.
- `name` — required string. `provider` — required, must be `"claude"`. `model` — required string. `apiKey` — optional string (stored obfuscated; empty/omitted means no key).
- **Response 201:** the updated `AiConfigsData`.
- **400** `{ "error": <message> }` — validation failures (e.g. `"id is required and must match [A-Za-z0-9_-]+"`, `"provider must be one of: claude"`) or `"AI config with id \"<id>\" already exists"`.

### `PUT /api/w/:wsId/ai-configs/:id`

Partial update. Body may contain any of `{ name, provider, model, apiKey }`; **omitted fields are preserved**. API-key semantics: omit → keep existing key; `""` → clear the key; non-empty string → replace it.

- **Response 200:** updated `AiConfigsData`.
- **400** `{ "error": "id is malformed" }`; per-field type errors; or `"AI config with id \"<id>\" not found"`.

### `PUT /api/w/:wsId/ai-configs/active`

Set the active config. Body `{ id: string }`. An empty string `""` means "no active config".

- **Response 200:** updated `AiConfigsData`.
- **400** `{ "error": "id must be a string" }`; `{ "error": "id is malformed" }`; or `"AI config with id \"<id>\" not found"` (non-empty id that doesn't exist).

### `DELETE /api/w/:wsId/ai-configs/:id`

Delete a config. **Refuses to delete the currently active config** — reassign active first.

- **Response 200:** updated `AiConfigsData`.
- **400** `{ "error": "id is malformed" }`; `"AI config with id \"<id>\" not found"`; or `"Cannot delete the active AI config; set another active first"`.

---

## Analysis prompts

`/api/w/:wsId/analysis-prompts`. An `AnalysisPrompt` = `{ name: string, text: string }`. `text` is a full prompt; a literal `{content}` placeholder, if present, is replaced with the post body when the prompt runs.

### `GET /api/w/:wsId/analysis-prompts/defaults`

The built-in default prompts (four: "Publishability & Trust", "Structure & Reader Momentum", "Depth & Credibility", "Completion Coach"). Used to seed/reset. Not workspace-data-dependent.

- **Response 200:** `AnalysisPrompt[]`.

### `GET /api/w/:wsId/analysis-prompts`

The workspace's saved prompts.

- **Response 200:** `AnalysisPrompt[]`.

### `PUT /api/w/:wsId/analysis-prompts`

Replace the saved prompts. Body: `AnalysisPrompt[]`; each element needs a non-empty `name` and a string `text`.

- **Response 200:** saved `AnalysisPrompt[]`.
- **400** `{ "error": <message> }`, e.g. `"analysis prompts must be an array"`, `"each prompt needs a non-empty name"`, `"each prompt needs a text string"`.

---

## Generation prompts

`/api/w/:wsId/generation-prompts`. Field-specific guidance strings for AI metadata generation. Shape: `{ prompts: Record<string,string> }`, keyed by the seven generatable metadata fields: `title`, `titleEn`, `slug`, `tags`, `tagsEn`, `metaDescription`, `metaDescriptionEn`. On save, only those known keys are kept; unknown keys are dropped.

### `GET /api/w/:wsId/generation-prompts/defaults`

Built-in default guidance for each field.

- **Response 200:** `{ prompts: Record<string,string> }`.

### `GET /api/w/:wsId/generation-prompts`

The workspace's saved guidance.

- **Response 200:** `{ prompts: Record<string,string> }`.

### `PUT /api/w/:wsId/generation-prompts`

Replace the guidance. Body `{ prompts: object }` where every value is a string.

- **Response 200:** the normalized `{ prompts }` (filtered to known keys).
- **400** `{ "error": "prompts must be an object" }`; `{ "error": "every prompt value must be a string" }`.

---

## AI operations (Claude-backed)

The three operations below call the active AI config's provider. They share a behavioral contract:

- **Active config required.** If the workspace has no active AI config, or the config has no API key, or the provider can't be constructed, the route returns **`503`** `{ "error": <message> }` (e.g. `"No active AI configuration selected"`, `"AI API key is not configured"`). 503 means "provider unavailable / not configured", distinct from 502 below.
- **Provider failure** (the model errored, refused, or hit its token cap mid-generation) returns **`502`** `{ "error": <message> }`. Claude-specific messages include `"Claude stopped before completing the response (hit the output token limit)."` and `"Claude refused the request."`.
- **Content source.** Each takes an optional `content` field; when it is a non-empty/non-whitespace string it is used as the draft text (so the client can analyze unsaved editor content), otherwise the stored post body is used.
- **Keys are read server-side only**; clients never send the API key with these calls.

### `POST /api/w/:wsId/analyze`

Run a named analysis prompt against a post and return the model's full text. Body `{ postId: string, promptName: string, content?: string }`.

- `postId`, `promptName` — required. `promptName` must match a saved analysis prompt.
- If the prompt text contains `{content}`, the content is inlined there ("inline-content" mode); otherwise the prompt is sent as the system message and the content as the user turn ("split-system-user" mode).
- **Response 200:** `{ "result": string }` — the complete analysis text.
- **400** `{ "error": "postId and promptName are required" }`.
- **404** `{ "error": "Post not found" }`; `{ "error": "Analysis prompt not found: <name>" }`.
- **503** / **502** per the shared contract.

### `POST /api/w/:wsId/analyze/stream`

Streaming variant of analyze. Same body and same pre-stream error codes (400/404/503, and 502 if the provider fails before any byte is sent). On success the response is **`application/x-ndjson`** — newline-delimited JSON frames, not a JSON document:

- `{"type":"delta","text":"..."}` — incremental output (zero or more).
- `{"type":"done"}` — the model completed normally. **A response without a final `done` frame must be treated as incomplete**, not as a successful result.
- `{"type":"error","message":"..."}` — the generation failed after streaming began (the HTTP status is already 200 at that point, so this frame is the only failure signal).

**Cancellation:** when the client closes the connection, the route aborts the upstream model stream. The client binding (`runAnalysisStream`) also accepts an `AbortSignal`, parses the frames, throws on an `error` frame, and throws `"Analysis ended unexpectedly before completing."` if the stream ends without a `done` frame.

### `POST /api/w/:wsId/metadata/generate`

Generate one or more metadata fields in a single structured (JSON-schema-constrained) model call. Body `{ postId: string, fields: string[], content?: string }`.

- `fields` — required, non-empty. Valid values are the seven generatable fields (`title`, `titleEn`, `slug`, `tags`, `tagsEn`, `metaDescription`, `metaDescriptionEn`). Unrecognized field names are not an error — they appear in the result with an `error` entry, and generation proceeds for the valid ones.
- **Response 200:** `{ "results": Record<string, { value: string } | { error: string }> }`, one entry per requested field. `value` is always a string — `tags`/`tagsEn` arrays are returned joined as `", "`-separated strings. On provider failure the still-200 response carries an `{ error }` entry for each valid field (the call does not 502 here; failures are reported per-field in the body).
  - Note: if `fields` contains only invalid names, the response is `200 { "results": { ... } }` with error entries and **no** provider call (so no 503 even without an active config).
- **400** `{ "error": "postId and fields[] are required" }`.
- **404** `{ "error": "Post not found" }` (only reached when at least one valid field is requested).
- **503** per the shared contract (only when at least one valid field is requested).
- Server-side timeout: 45 s, with 1 retry, for the model call. The client binding applies its own 95 s overall fetch timeout (`"Metadata generation timed out"`).

### `POST /api/w/:wsId/imaging`

Generate distinct English image-generation prompts for a post via a structured model call. Body `{ postId: string, content?: string, count?, relation?, emotionalLens?, literalness?, people?, style? }`. Each option is validated against an allowed set; **an invalid or omitted option silently falls back to its default** (no 400):

- `count` — `3 | 5 | 10`, default `5`.
- `relation` — `direct | domain | abstract`, default `domain`.
- `emotionalLens` — `bright | calm | neutral | intense | hopeful`, default `hopeful`.
- `literalness` — `literal | stylized | symbolic`, default `stylized`.
- `people` — `people | mixed | no-people`, default `mixed`.
- `style` — `photo | illustration | anime | cinematic | minimal`, default `illustration`.
- **Response 200:** `{ "items": string[] }` — exactly `count` unique, non-empty prompt strings.
- **400** `{ "error": "postId is required" }`.
- **404** `{ "error": "Post not found" }`.
- **503** (provider unavailable) / **502** (provider failure) per the shared contract.
- Server-side timeout: 60 s, 1 retry, max 4096 output tokens. The client binding applies a 130 s overall fetch timeout (`"Imaging generation timed out"`).

---

## Assets

`/api/w/:wsId/assets`. Binary files attached to a post, stored at `assets/<postId>/<filename>`. `AssetMeta` = `{ filename, size (bytes), width?, height?, hasMetadata?, uploadedAt (ISO 8601) }`. `width`/`height` are filled for recognized image types; `hasMetadata` is `true` when EXIF/IPTC/XMP metadata was detected at upload (a privacy flag). `postId` must match `^[A-Za-z0-9_-]+$`; `filename` must be a single path component (no separators, no `..`, no NUL) — both are validated to block path traversal.

### `GET /api/w/:wsId/assets/:postId`

List a post's assets. The list is reconciled against the files actually on disk, so it is consistent even after an interrupted upload/delete.

- **Response 200:** `AssetMeta[]` (empty array if the post has no assets; does not 404 on an unknown post here).
- **400** `{ "error": "Invalid postId" }`.
- **500** `{ "error": <message> }` on a store error.

### `POST /api/w/:wsId/assets/:postId`

Upload one file. **`multipart/form-data`** with a single field named `file`. The per-file size limit is the workspace's `settings.maxUploadMb` (default 500 MB). The uploaded filename is sanitized (basename only; characters outside `[A-Za-z0-9._-]` become `_`); a same-named existing asset is replaced. Dimensions and EXIF presence are computed for image extensions (`jpg/jpeg/png/gif/webp/avif`).

- **Response 201:** the new `AssetMeta`.
- **400** `{ "error": "Invalid postId" }`; `{ "error": "No file provided" }`.
- **404** `{ "error": "Post not found" }`.
- **409** `{ "error": "Published posts are locked. Move the post back to Checked or Draft to change its assets." }`.
- **500** `{ "error": <message> }` on a store error. Oversized uploads are rejected by multer (its error surfaces through the global handler).

### `GET /api/w/:wsId/assets/:postId/:filename/raw`

Serve the raw file bytes (this is the URL the client uses for `<img>` sources, via `assetUrl(...)`). Responses set `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` to isolate the file in its own origin. Recognized inline image types (`jpg/jpeg/png/gif/webp/avif`) are served with their image content type; everything else is served as `application/octet-stream` with a `Content-Disposition: attachment` (forced download).

- **Response 200:** the raw file body (content type as above), streamed.
- **400** `{ "error": "Invalid postId or filename" }`; `{ "error": "Invalid path" }` (path-escape attempt).
- **404** `{ "error": "Asset not found" }`.
- **500** `{ "error": "Failed to read asset" }` if the read stream fails before headers are sent.

### `DELETE /api/w/:wsId/assets/:postId/:filename`

Delete one asset file (and prune its metadata entry).

- **Response 204:** no body.
- **400** `{ "error": "Invalid postId or filename" }`; `{ "error": "Invalid path" }`.
- **404** `{ "error": "Asset not found" }` (file missing) or `{ "error": "Post not found" }`.
- **409** `{ "error": "Published posts are locked. Move the post back to Checked or Draft to change its assets." }`.
- **500** `{ "error": <message> }` on a store error.

---

## Operational caveats worth knowing

- **No auth, by design.** Treat reachability as authorization. Do not expose the server beyond loopback without a separate access-control layer (firewall, reverse proxy with auth). The Origin guard stops cross-origin browser CSRF but does nothing against a direct non-browser client.
- **Published posts are locked.** `PUT /posts/:id`, asset upload, and asset delete all return `409` for a published post. To edit, move it back to `checked` or `draft` first (which, if dropping to `draft`, discards `publishedAtUtc`).
- **Provider failure taxonomy.** `503` = AI not configured/unavailable (no active config, no key, provider init failed). `502` = the model call itself failed (error, refusal, token cap). `metadata/generate` is the exception: provider failures are reported per-field inside a `200` body, not as `502`.
- **Streaming completeness.** For `analyze/stream`, a `200` with streamed text but no terminal `done` frame is a truncated/failed generation — never present partial streamed text as a finished analysis.
- **Derived caches self-heal.** `posts/index.json` and each `assets/<postId>/meta.json` are rebuilt from the source files on read; an interrupted write reconciles on the next read. `POST /posts/index/rebuild` forces a full post-index rebuild.
- **Timeouts differ between layers.** The server caps the model call (metadata 45 s, imaging 60 s); the browser client caps the whole fetch at a larger value (metadata 95 s, imaging 130 s). A request can therefore fail server-side (model timeout → reported in-body or as 502) before the client's own timeout fires.

## Points to verify against the running system

- **Imaging `count` typing.** The route accepts `count` only when it is one of `3 | 5 | 10`; any other number (or a non-number) silently becomes `5`. Confirm callers send one of the three, since out-of-set values are dropped without an error.
- **`open-or-create` returns 201 for existing workspaces.** The status code is always `201` even when an existing workspace is opened/returned, which is mildly surprising for an idempotent "open". Verify clients do not treat 201 as strictly "created".
- **No publish-time validation.** The status-change route has no slug/metadata gate despite a code comment referencing one; `target.requiresMetadata` is stored but not enforced server-side on publish. If a publish gate is expected, it must live in the client. Confirm whether this is intended.
- **`metadata/generate` with only invalid fields** returns `200` with per-field errors and makes no provider call — so it will not surface a `503` even when no AI config is active. Verify this matches caller expectations.
