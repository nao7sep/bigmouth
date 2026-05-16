# BigMouth

A local-first writing preflight tool for composing and reviewing blog posts and social media content before publishing.

## What it does

BigMouth is a single-user desktop-style web app (Node.js backend + React frontend) that runs entirely on your machine. You write posts in Markdown, run AI-powered quality and safety checks, generate metadata, and export when ready. There is no sync, no cloud storage, and no direct publishing — you copy and paste to your platform of choice.

## Features

- **Workspaces** — manage multiple isolated workspaces, each with its own posts, assets, settings, and AI configuration. Switch between workspaces without reloading. You can point a workspace at any directory, making it easy to version-control workspace data with Git.
- **Markdown editor** with autosave, live post-list updates, and resizable panes
- **Three-stage workflow**: Draft → Ready → Published
- **Analysis** — run named prompts against post content to catch issues before publishing, with results appearing progressively in the analysis pane while the model responds
- **AI metadata generation** — generate title, slug, tags, SEO description, and more with one click
- **Imaging** — generate temporary English image-prompt variants from the current post and metadata with adjustable relation, tone, literalness, people, and style while preserving the draft's own implied setting
- **Assets** — upload and manage images and files per post; embed links directly in the editor
- **Export** — copy or download post content as HTML or plain text
- **Multi-language support** — write in any language; generate English supplement fields for non-English posts
- **Targets** — configure multiple publishing destinations with per-target metadata requirements
- **Source linking** — link a post to a source post (e.g. a translation derived from an original)
- **Navigation history** — back-navigate through linked posts
- **Fast local post index** — list refreshes stay cheap while Markdown files remain the source of truth

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

In production, the built client is served from the same origin as the API. In development, Vite (port 5173) proxies `/api/*` to the backend so requests are also same-origin from the browser's perspective. There is no CORS — see [Security model](#security-model).

## Data directory

All data is stored locally under `~/.bigmouth/`:

```
~/.bigmouth/
  app.json                         ← port and workspace registry
  logs/                            ← server log files, one per server start (shared across workspaces)
  workspaces/
    {workspace-id}/                ← default location for workspace data
      posts/
        drafts/                    ← draft posts (.md files)
        ready/                     ← ready-to-publish posts (.md files)
        published/                 ← published posts (.md files)
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

Each workspace has an explicit `dataDirectory` path. This can be any directory on disk — useful for Git version control of workspace data. Leaving the location blank uses the default `~/.bigmouth/workspaces/{workspace-id}` location. If the chosen folder already contains a bigmouth workspace, the app opens it; otherwise bigmouth creates a new workspace there. It will still refuse to initialize inside a non-empty folder that contains unrelated files.

Each post is a Markdown file with YAML front matter. The filename encodes the slug (ready/published posts) or the post ID (drafts).

### Logging

Logs are written under `~/.bigmouth/logs/`, with one log file per server start. They are shared across workspaces because the app runs as a single local server process.

The server logs request start/finish, workspace resolution, major app actions, successes, failures, and unexpected process-level errors. Request logs record metadata such as routes and body/query keys, not full post content. Post updates log lifecycle-safe details such as status transitions, slug changes, timestamp preservation, and content lengths. Metadata and imaging generation logs include provider/model, requested fields or options, source lengths, metadata keys, and output summaries, not full drafts or generated prose. Failed AI requests log provider error details, and raw model output is only logged in code paths that receive unusable free-form output.

Use the hamburger menu → **Reveal Log** to open the current log file in your OS file manager.

## Workspaces

Workspaces provide complete isolation: each has its own posts, assets, settings, targets, AI configs, and prompts.

- On startup, the frontend shows a workspace modal if no workspace is selected (or the saved workspace no longer exists).
- Switch workspaces at any time via the hamburger menu → "Workspaces".
- The backend is stateless with respect to workspaces — every API request includes the workspace ID in the URL path (`/api/w/:wsId/...`), so two browser tabs can work on different workspaces simultaneously.
- Open an existing workspace folder, or create a new workspace in the chosen folder.
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

### AI configuration (per workspace)

AI providers are configured through the Settings UI. Currently supported: **Claude (Anthropic)**. API keys are stored obfuscated in `ai-configs.json`.

New workspaces start with a default Claude config entry and an empty API key.

When the Settings UI loads an existing AI configuration, the API key field stays empty. The plaintext key is never sent over HTTP. Instead, the UI indicates whether a key is already saved. Leave the field blank to keep the existing key, or type a new one to replace it.

### Analysis prompts (`analysis-prompts.json`, per workspace)

Named prompts for AI content review. Use `{content}` as a placeholder for the post body. This works well with XML-style sections such as:

```text
<content>
{content}
</content>
```

If `{content}` is omitted, the app keeps the older compatibility behavior and sends the prompt as instructions plus the post content separately.

The built-in prompt set now covers publishing risk, distinctiveness and credibility, calibration and bias, reader value and structure, and elaboration coaching. They are designed to reply in the same language as the post, focus on the most important points, and stay constructive rather than nitpicky. Analysis output is streamed into the pane progressively while the model is still responding. The Settings UI can restore the current built-in set into your workspace file at any time.

### Generation prompts (`generation-prompts.json`, per workspace)

Field guidance used when auto-generating metadata fields (title, slug, tags, etc.). The app now owns the request-level prompt and JSON schema, sends the draft content and existing metadata automatically, and asks Claude for only the requested fields. `Generate All` uses one structured request so titles, tags, slugs, and descriptions are generated together; individual Generate buttons use the same structured path with a one-field schema.

Older workspace prompt files that still contain `{content}`, `{json}`, or return-format instructions continue to load. Those legacy output-format lines are ignored when building the structured metadata request.

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
2. **Ready** — Mark ready when reviewed. A slug is required to advance from draft.
3. **Published** — Mark as published after copying to your platform. The post moves to the published archive. Content, metadata, and assets remain editable for small corrections; `publishedAtUtc` changes only when the status changes to Published.

Posts can be moved backward (Published → Ready → Draft) at any time. Moving a published post backward clears `publishedAtUtc`; publishing it again sets a new publication timestamp.

While you edit, the left-hand post list updates the affected entry in place instead of reloading every section from scratch. The published archive still loads in pages via “Load more…”.

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
| `PUT /api/w/:wsId/posts/:id` | Update a post |
| `PUT /api/w/:wsId/posts/:id/status` | Change post status |
| `DELETE /api/w/:wsId/posts/:id` | Delete a post |
| `GET /api/w/:wsId/settings` | Get settings |
| `PUT /api/w/:wsId/settings` | Save settings |
| `GET /api/w/:wsId/targets` | Get targets |
| `PUT /api/w/:wsId/targets` | Save targets |
| `PUT /api/w/:wsId/targets/rename` | Rename a target and update posts using it |
| `GET /api/w/:wsId/ai-configs` | Get AI configs |
| `PUT /api/w/:wsId/ai-configs` | Save AI configs |
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
- **Path validation.** Asset filenames and post slugs are validated against a strict character set, and asset paths are resolved under the per-post asset directory and rejected if they escape.
- **Workspace data directories.** Pointing a workspace at a custom path creates the directory if it does not exist. If the path already exists, it must be either empty or an existing bigmouth workspace; non-empty unrelated folders are rejected.

If you change the listening port via `app.json`, the loopback same-origin allowlist follows it automatically. To work with the dev frontend on a different port than `5173`, edit `DEV_ORIGINS` in `server/src/index.ts`.

## License

MIT — © 2026 Yoshinao Inoguchi
