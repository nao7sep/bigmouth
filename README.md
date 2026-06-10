# BigMouth

A local-first writing preflight tool for composing and reviewing blog posts and social media content before publishing.

## What it does

BigMouth is a single-user desktop-style web app (Node.js backend + React frontend) that runs entirely on your machine. You write posts in Markdown, run AI-powered quality and safety checks, generate metadata, and export when ready. There is no sync, no cloud storage, and no direct publishing — you copy and paste to your platform of choice.

## Features

- **Workspaces** — manage multiple isolated workspaces, each with its own posts, assets, settings, and AI configuration. Switch between workspaces without reloading. You can point a workspace at any directory, making it easy to version-control workspace data with Git.
- **Markdown editor** with autosave, live post-list updates, and resizable panes
- **Three-stage workflow**: Draft → Checked → Published
- **Analysis** — run named prompts against post content to catch issues before publishing, with results appearing progressively in the analysis pane while the model responds
- **AI metadata generation** — generate title, slug, tags, SEO description, and more with one click
- **Imaging** — generate temporary English image-prompt variants from the current post and metadata with adjustable relation, tone, literalness, people, and style while preserving the draft's own implied setting
- **Assets** — upload and manage images and files per post; embed links directly in the editor. Raster images preview inline; other files are served as downloads.
- **Export** — copy or download post content as HTML or plain text
- **Multi-language support** — write in any language; generate English supplement fields for non-English posts
- **IME composition support** — Japanese/Chinese/Korean input works correctly in all text fields
- **Targets** — configure multiple publishing destinations with per-target metadata requirements
- **Source linking** — link a post to a source post (e.g. a translation derived from an original). Deleting a source automatically unlinks the posts that referenced it, and you're told how many before confirming.
- **Navigation history** — back-navigate through linked posts
- **Single-folder, diff-friendly storage** — every post is one Markdown file with a name that never changes, so edits and status changes show up as clean in-place diffs. A derived, version-controllable index (`posts/index.json`) keeps the published archive and search cheap while the Markdown files remain the source of truth.

## Requirements

- Node.js 20.19 or later
- npm

## Getting started

```sh
# Install dependencies
npm install

# Start in development mode (hot-reload frontend + backend)
npm run dev

# Or build for production and run
npm run build
node server/dist/index.js
```

The server starts on `http://localhost:3141` by default. Open that URL in your browser. On first visit you will see the workspace modal — create a workspace to get started.

In production, the built client is served from the same origin as the API. In development, Vite (port 5273) proxies `/api/*` to the backend so requests are also same-origin from the browser's perspective. There is no CORS — see [Security model](#security-model).

## Testing

Tests run with [Vitest](https://vitest.dev/) in both packages.

```sh
# Run the full suite (server + client)
npm test

# Watch mode (run per package)
npm run test:watch --prefix server
npm run test:watch --prefix client
```

Server tests run in a Node environment; client tests run in jsdom. Coverage focuses on the logic-bearing modules — timestamp/filename formatting, markdown sanitization and counting, AI prompt assembly and response validation, the post and config stores (exercised against temporary data directories), the HTTP routes, the post-picker hook (load, pagination, de-duplication, and error surfacing), and the metadata tab's autosave across its debounce, Generate All, and flush paths (including the edit-during-save race: a field re-edited while its save is in flight stays dirty until the newer value is persisted, never dropped).

Each package keeps its tests in a `tests/` directory that mirrors `src/` (e.g. `server/tests/routes/`, `client/tests/util/`, `client/tests/hooks/`, `client/tests/components/`), rather than colocated next to the source.

## Data directory

All data is stored locally under `~/.bigmouth/`:

```
~/.bigmouth/
  app.json                         ← port and workspace registry
  logs/                            ← server log files (yyyymmdd-hhmmss-utc.log), one per server start, shared across workspaces
  workspaces/
    {workspace-id}/                ← default location for workspace data
      posts/
        {createdAtUtc}-{id}.md     ← every post lives here, regardless of status
        index.json                 ← derived catalog of all posts (rebuildable)
      assets/
        {postId}/                  ← per-post uploaded files + meta.json
      settings.json
      ai-configs.json
      targets.json
      analysis-prompts.json
      generation-prompts.json
```

### app.json

The central configuration file. Contains the server port, bind host, origin allowlist, and the list of workspaces:

```json
{
  "port": 3141,
  "host": "127.0.0.1",
  "allowedOrigins": [],
  "workspaces": [
    {
      "id": "V1StGXR8_Z5jD",
      "name": "My Blog",
      "dataDirectory": "/Users/you/.bigmouth/workspaces/V1StGXR8_Z5jD"
    },
    {
      "id": "k3F9xPq2_mNwR",
      "name": "Tech Notes",
      "dataDirectory": "/another/path/technotes"
    }
  ]
}
```

`app.json` is expected to include both `host` and `allowedOrigins`.

| Field | Default | Description |
|---|---|---|
| `port` | `3141` | TCP port to listen on. |
| `host` | `"127.0.0.1"` | Bind address. Loopback by default. Set to `"0.0.0.0"` to listen on all interfaces, or to a specific LAN IP to pin to one NIC. |
| `allowedOrigins` | `[]` | Extra `Origin` values the CSRF guard accepts. Loopback origins are always allowed; any non-loopback hostname you want to access bigmouth from must appear here. |
| `workspaces` | `[]` | Workspace registry, managed through the API. |

Each workspace has an explicit `dataDirectory` path. This can be any directory on disk — useful for Git version control of workspace data. Leaving the location blank uses the default `~/.bigmouth/workspaces/{workspace-id}` location. If the chosen folder already contains a complete bigmouth workspace, the app opens it; otherwise bigmouth creates a new workspace there. It refuses to initialize inside a non-empty folder that contains unrelated or partial workspace files.

### Posts and the index

Each post is one Markdown file with YAML front matter, stored directly under `posts/` regardless of its status. The filename is `{createdAtUtc}-{id}.md` (e.g. `20260405-143022-utc-V1StGXR8_Z5jD.md`) and is **fixed for the post's entire lifetime** — computed once at creation and never recomputed. Because the name never changes, a status change or an edit rewrites the file in place and shows up as a clean in-place diff rather than a delete-plus-add. The creation-timestamp prefix keeps the directory, and your git history, in creation order.

This is a deliberate trade-off, not an oversight: posts are reviewed and published in whatever order you choose, so the on-disk order (creation time) will not match publication order. The benefit is that diffs read in a stable, meaningful sequence and survive every status change.

`posts/index.json` is a derived catalog — a fixed projection of every post's front matter (id, status, target, language, slug, title, tags, the lifecycle timestamps, and — for untitled posts — a short body excerpt used as a list label), excluding the body and the frequently-changing `updatedAtUtc`. The Markdown files are the source of truth; the index exists so the published archive and search stay cheap without reading thousands of files. It is:

- **Maintained automatically.** Each post change updates the matching index row. A content-only autosave never rewrites the index, so editing does not churn it.
- **Self-healing.** On load the app reconciles the index against the files on disk (a directory listing, no body reads) and repairs added or removed posts.
- **Deterministic.** Rebuilding from the same set of Markdown files always produces a byte-identical `index.json` (entries sorted by creation time, then id). This makes it safe to commit alongside the Markdown so a git diff shows both in sync.
- **Rebuildable.** Settings → General → **Rebuild index** regenerates it from the Markdown files. Use it after editing or merging post files outside the app.

### Logging

Logs are written under `~/.bigmouth/logs/`, one file per server start named `yyyymmdd-hhmmss-utc.log` (the UTC launch time). They are shared across workspaces because the app runs as a single local server process, and they are never auto-deleted, rotated, or pruned — an old log may be exactly what's needed to debug a problem that surfaces much later.

Each line is **one JSON object** (JSON Lines), carrying a fixed envelope — `time` (UTC ISO-8601 with milliseconds), `level`, and `message` — plus event-specific fields. There are four levels: `error`, `warn`, and `info` are always written; `debug` is developer-only and emitted **only** when explicitly enabled. The development server (`npm run dev`) starts the backend with `--debug-logs`; manual starts can set `BIGMOUTH_DEBUG=1`. Every emitted line is written synchronously to disk; if the log file can't be written the server degrades to the console rather than crashing.

The server logs startup (version and effective config), shutdown (with the signal), every request at its start and result (method, path, status, duration, and response size — never request or response bodies), workspace resolution, the major app actions, and every warning and error individually with full fidelity (error type, message, stack, and cause chain). Unhandled exceptions are logged before the process exits; unhandled promise rejections are logged as process-level errors. Post updates log lifecycle-safe details such as status transitions, slug changes, timestamp preservation, and content lengths. Metadata and imaging generation log provider/model, requested fields or options, source lengths, metadata keys, and output summaries — not full drafts or generated prose. When the provider returns unusable free-form output, that raw output is captured in a single `rawResponse` field (not a multi-line block).

A mandatory, non-destructive redaction pass replaces the value of any field whose name matches a denied key (`apiKey`, `authorization`, `token`, `password`, `secret` — matched exactly and case-insensitively) with `"[redacted]"`. It never inspects message text or string contents; the primary defense remains logging summaries rather than whole objects.

Use the hamburger menu → **Reveal Log** to open the current log file in your OS file manager.

## Workspaces

Workspaces provide complete isolation: each has its own posts, assets, settings, targets, AI configs, and prompts.

- On startup, the frontend shows a workspace modal if no workspace is selected (or the saved workspace no longer exists).
- Switch workspaces at any time via the hamburger menu → "Workspaces".
- The backend is stateless with respect to workspaces — every API request includes the workspace ID in the URL path (`/api/w/:wsId/...`), so two browser tabs can work on different workspaces simultaneously.
- Open an existing complete workspace folder, or create a new workspace in the chosen folder.
- **Deleting a workspace only removes it from the registry** (`app.json`). The data directory and all files inside it are left untouched on disk.

## Configuration

### Settings (`settings.json`, per workspace)

| Field | Default | Description |
|---|---|---|
| `timezone` | `"Asia/Tokyo"` | IANA timezone (e.g. `"Asia/Tokyo"`) |
| `supportedLanguages` | `["en", ...]` | ISO 639-1 codes shown in language selects |
| `publishedPostsPerLoad` | `50` | How many published posts to load per page |
| `maxUploadMb` | `500` | Max asset upload size in MB |
| `editorWatermark` | — | Placeholder shown in an empty editor |
| `extraFieldWatermark` | — | Placeholder shown in the extra metadata field |

### Targets (`targets.json`, per workspace)

A target represents a publishing destination:

```json
[
  {
    "name": "blogger-personal",
    "defaultLanguage": "en",
    "requiresMetadata": true
  }
]
```

When `requiresMetadata` is `false`, the post's **Metadata tab is hidden entirely** — useful for short social posts (e.g. X/Twitter) that need no title, slug, tags, or SEO description. Metadata is always optional regardless of this flag; it never blocks a status change.

### AI configuration (per workspace)

AI providers are configured through the Settings UI. Currently supported: **Claude (Anthropic)**. API keys are stored obfuscated in `ai-configs.json`.

New workspaces start with a default Claude config entry and an empty API key.

When the Settings UI loads an existing AI configuration, the API key field stays empty. The plaintext key is never sent over HTTP. Instead, the UI indicates whether a key is already saved. Leave the field blank to keep the existing key, or type a new one to replace it.

Each config is managed as its own resource. `POST /ai-configs` creates one, `PUT /ai-configs/:id` updates it, `DELETE /ai-configs/:id` removes it, and `PUT /ai-configs/active` sets which config the analysis and generation routes use. Field semantics for `PUT /ai-configs/:id` are explicit:

- A field omitted from the body preserves the existing value.
- `apiKey: ""` clears the stored key.
- `apiKey: "..."` replaces the stored key.

The server refuses to delete the currently active config — reassign `activeId` to another config first.

### Analysis prompts (`analysis-prompts.json`, per workspace)

Named prompts for AI content review. Use `{content}` as a placeholder for the post body. This works well with XML-style sections such as:

```text
<content>
{content}
</content>
```

If `{content}` is omitted, the app sends the prompt as instructions and the post content as the user message.

The built-in prompt set covers publishability and trust, reader momentum and structure, depth and credibility, and completion coaching. They are designed to reply in the same language as the post, name real strengths without empty praise, focus on high-leverage edits, and help the writer finish rather than over-polish. Analysis output is streamed into the pane progressively while the model is still responding. The Settings UI can restore the current built-in set into your workspace file at any time.

### Generation prompts (`generation-prompts.json`, per workspace)

Field guidance used when auto-generating metadata fields (title, slug, tags, etc.). The app now owns the request-level prompt and JSON schema, sends the draft content and existing metadata automatically, and asks Claude for only the requested fields. `Generate All` uses one structured request so titles, tags, slugs, and descriptions are generated together; individual Generate buttons use the same structured path with a one-field schema.

The built-in defaults keep metadata close to what the draft actually says, preserve the author's perspective, align fields around the same central angle, make slugs read like short English phrases, keep tags short and searchable, and tell the English title/description prompts not to add extra drama or stronger emotion.

Built-in prompt text is owned by the server, and the Settings UI can restore the current built-in set into your workspace file at any time.

### Imaging

Imaging is transient. Generated prompts are shown in the tab and can be copied, but they are not written to post front matter, workspace config, or history.

Imaging uses the same structured AI output path as metadata generation. The server asks the provider for an exact schema with an `items` array containing the requested number of English prompts:

```json
{"items":["prompt 1","prompt 2"]}
```

## Post workflow

1. **Draft** — Create a post, pick a target and language. Write in Markdown. Content autosaves every 2 seconds.
2. **Checked** — Mark a post checked once you have reviewed it. Metadata (including the slug) is optional and never required to change status. This is the staging lane: keep a handful of checked posts, give them a final read, then copy-paste them out.
3. **Published** — Mark as published after copying to your platform. **Published posts are locked** — their content, metadata, and assets are read-only, so the autosaving editor can never silently change a post you have already published.

Posts can be moved backward at any time, and the move is the only way to edit a published post:

- **Published → Checked** unlocks the post for editing and **preserves both timestamps**. This is the lane for fixing a typo without changing the publication record — edit, then move back to Published.
- **Published → Draft** is for a real rewrite-and-repost. It **clears the checked and publication timestamps**; the post is treated as never published until you publish it again. The app asks for confirmation first.

### Lifecycle timestamps

Two timestamps track how far a post has advanced. Both are set the first time the post reaches a state and are cleared only when it drops back to draft:

| Transition | `checkedAtUtc` | `publishedAtUtc` |
|---|---|---|
| → Checked (first time) | set | — |
| Checked → Draft | cleared | — |
| → Published (first time) | set | set |
| Published → Checked | kept | **kept** |
| Checked → Published again | kept | **kept** (not overwritten) |
| Published → Draft | cleared | cleared |

Because re-publishing only sets `publishedAtUtc` when it is absent, the round trip Published → Checked → Published (used to fix a typo) keeps the original publication time. Only a deliberate return to Draft discards it.

While you edit, the left-hand post list updates the affected entry in place instead of reloading every section from scratch. Drafts and checked posts are ordered by creation time; the published archive is ordered by publication time and loads in pages via “Load more…”. Deleting the open post selects its neighbour in the same section, so you keep your place instead of dropping back to an empty pane.

## API routes

All workspace-scoped routes are prefixed with `/api/w/:wsId/`. Workspace management routes are at `/api/workspaces`.

| Route | Description |
|---|---|
| `GET /api/health` | Health check |
| `GET /api/logs/current` | Get the current log file path |
| `POST /api/logs/current/reveal` | Reveal the current log file in the OS file manager |
| `GET /api/workspaces` | List all workspaces |
| `GET /api/workspaces/:id` | Get a workspace |
| `POST /api/workspaces/open-or-create` | Open an existing workspace folder or create one there |
| `PUT /api/workspaces/:id` | Update a workspace |
| `DELETE /api/workspaces/:id` | Remove a workspace from the registry (data files are not deleted) |
| `GET /api/w/:wsId/posts` | List posts |
| `GET /api/w/:wsId/posts/:id` | Get a post |
| `POST /api/w/:wsId/posts` | Create a post |
| `POST /api/w/:wsId/posts/index/rebuild` | Rebuild the post index from the Markdown files |
| `PUT /api/w/:wsId/posts/:id` | Update a post (rejected with `409` while the post is published) |
| `GET /api/w/:wsId/posts/:id/referrers` | List posts that link this one as their source |
| `PUT /api/w/:wsId/posts/:id/status` | Change post status |
| `DELETE /api/w/:wsId/posts/:id` | Delete a post |
| `GET /api/w/:wsId/settings` | Get settings |
| `PUT /api/w/:wsId/settings` | Save settings |
| `GET /api/w/:wsId/targets` | Get targets |
| `PUT /api/w/:wsId/targets` | Save targets |
| `PUT /api/w/:wsId/targets/rename` | Rename a target and update posts using it |
| `GET /api/w/:wsId/ai-configs` | Get AI configs |
| `POST /api/w/:wsId/ai-configs` | Create an AI config |
| `PUT /api/w/:wsId/ai-configs/active` | Set the active AI config |
| `PUT /api/w/:wsId/ai-configs/:id` | Update an AI config |
| `DELETE /api/w/:wsId/ai-configs/:id` | Delete an AI config |
| `GET /api/w/:wsId/analysis-prompts` | Get analysis prompts |
| `GET /api/w/:wsId/analysis-prompts/defaults` | Get built-in analysis prompts |
| `PUT /api/w/:wsId/analysis-prompts` | Save analysis prompts |
| `GET /api/w/:wsId/generation-prompts` | Get generation prompts |
| `GET /api/w/:wsId/generation-prompts/defaults` | Get built-in generation prompts |
| `PUT /api/w/:wsId/generation-prompts` | Save generation prompts |
| `POST /api/w/:wsId/analyze` | Run analysis |
| `POST /api/w/:wsId/analyze/stream` | Stream analysis |
| `POST /api/w/:wsId/metadata/generate` | Generate requested metadata fields in one structured request |
| `POST /api/w/:wsId/imaging` | Generate temporary image prompts |
| `GET /api/w/:wsId/assets/:postId` | List assets |
| `POST /api/w/:wsId/assets/:postId` | Upload an asset |
| `DELETE /api/w/:wsId/assets/:postId/:filename` | Delete an asset |
| `GET /api/w/:wsId/assets/:postId/:filename/raw` | Serve raw asset file |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Cmd/Ctrl + N | New post |
| Cmd/Ctrl + E | Export |
| Cmd/Ctrl + Enter | Run analysis |
| Cmd/Ctrl + 1 | Switch to Analysis tab |
| Cmd/Ctrl + 2 | Switch to Imaging tab |
| Cmd/Ctrl + 3 | Switch to Assets tab |
| Cmd/Ctrl + 4 | Switch to Preview tab |
| Cmd/Ctrl + 5 | Switch to Metadata tab |

## LAN access

By default bigmouth is loopback-only. To use one machine as the server and edit posts from another device on the same network (a laptop, an iPad, etc.), edit `~/.bigmouth/app.json` on the server machine:

```json
{
  "port": 3141,
  "host": "0.0.0.0",
  "allowedOrigins": [
    "http://192.168.1.50:3141",
    "http://my-mac.local:3141"
  ],
  "workspaces": [...]
}
```

- `host` controls which interfaces the server listens on. `"0.0.0.0"` listens on every interface. If you want to pin to one NIC, use that interface's IP address (e.g. `"192.168.1.50"`).
- `allowedOrigins` must list every URL that the client device will use to reach the server. Browsers send the `Origin` header with the exact host and port the user typed; if it's not in the list, the request is rejected with `403`. Include both the IP form and the `.local`/hostname form if you use either.
- The port number in each entry must match `port`.

There is **no authentication**. This setup is only safe behind a firewall on a trusted network. Anyone who can reach the host on the configured port and whose browser sends an allowed `Origin` can read and modify all workspace data, including stored API keys (used server-side for AI calls). On startup, bigmouth logs a warning when it binds to a non-loopback address.

Restart the server after editing `app.json`.

## Security model

BigMouth has no authentication — it is designed for a single user on their own machine. The protections that keep that safe in practice:

- **Loopback only by default.** The server binds to `127.0.0.1`. Set `host` in `app.json` to expose it to a trusted LAN — see [LAN access](#lan-access).
- **Same-origin only.** Requests from any `Origin` other than the loopback host (production), the Vite dev server, or an entry in `allowedOrigins` are rejected with `403 Forbidden`. CORS is disabled. This prevents a malicious page you visit in your browser from issuing cross-site requests against the API.
- **API keys never leave the server in plaintext.** The `GET /api/w/:wsId/ai-configs` response masks every API key. The plaintext form is only deobfuscated in-process when calling the AI provider.
- **Rendered Markdown is sanitized.** Preview and streamed analysis output are sanitized before being inserted into the app UI, so raw HTML in drafts or AI output cannot run scripts in the BigMouth origin.
- **Path validation.** Asset filenames and post slugs are validated against a strict character set, and asset paths are resolved under the per-post asset directory and rejected if they escape.
- **Safer asset serving.** Raster image assets can render inline. Other uploaded file types are served as downloads with `nosniff` and a sandbox content policy, so uploaded HTML/SVG-like files are not treated as executable same-origin documents.
- **Workspace data directories.** Pointing a workspace at a custom path creates the directory if it does not exist. If the path already exists, it must be either empty or a complete bigmouth workspace; non-empty unrelated or partial workspace folders are rejected rather than repaired.

If you change the listening port via `app.json`, the loopback same-origin allowlist follows it automatically. To work with the dev frontend on a different port than `5273`, edit `DEV_ORIGINS` in `server/src/index.ts`.

## License

MIT — © 2026 Yoshinao Inoguchi
