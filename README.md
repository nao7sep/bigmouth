# BigMouth

A local-first writing preflight tool for composing and reviewing blog posts and social media content before publishing.

## What it does

BigMouth is a single-user desktop-style web app (Node.js backend + React frontend) that runs entirely on your machine. You write posts in Markdown, run AI-powered quality and safety checks, generate metadata, and export when ready. There is no sync, no cloud storage, and no direct publishing — you copy and paste to your platform of choice.

## Features

- **Workspaces** — manage multiple isolated workspaces, each with its own posts, assets, settings, and AI configuration. Switch between workspaces without reloading. You can point a workspace at any directory, making it easy to version-control workspace data with Git.
- **Markdown editor** with autosave, live post-list updates, and resizable panes
- **Three-stage workflow**: Draft → Ready → Published
- **AI analysis** — run named prompts against post content to catch issues before publishing
- **AI metadata generation** — generate title, slug, tags, SEO description, and more with one click
- **Assets** — upload and manage images and files per post; embed links directly in the editor
- **Export** — copy post content as HTML or plain text
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

## Data directory

All data is stored locally under `~/.bigmouth/`:

```
~/.bigmouth/
  app.json                         ← port and workspace registry
  logs/                            ← server log files (shared across workspaces)
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

The central configuration file. Contains the server port and the list of workspaces:

```json
{
  "port": 3141,
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

Each workspace has an explicit `dataDirectory` path. This can be any directory on disk — useful for Git version control of workspace data.

Each post is a Markdown file with YAML front matter. The filename encodes the slug (ready/published posts) or the post ID (drafts).

## Workspaces

Workspaces provide complete isolation: each has its own posts, assets, settings, targets, AI configs, and prompts.

- On startup, the frontend shows a workspace modal if no workspace is selected (or the saved workspace no longer exists).
- Switch workspaces at any time via the hamburger menu → "Switch Workspace".
- The backend is stateless with respect to workspaces — every API request includes the workspace ID in the URL path (`/api/w/:wsId/...`), so two browser tabs can work on different workspaces simultaneously.
- Create a workspace with a custom data directory to version-control it with Git.

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

### Analysis prompts (`analysis-prompts.json`, per workspace)

Named prompts for AI content review. Use `{content}` as a placeholder — text before it becomes the system prompt; the post content becomes the user message. If `{content}` is omitted, the full prompt is used as the system prompt.

### Generation prompts (`generation-prompts.json`, per workspace)

Prompts used to auto-generate individual metadata fields (title, slug, tags, etc.). A shared preamble is prepended to each field-specific prompt.

## Post workflow

1. **Draft** — Create a post, pick a target and language. Write in Markdown. Content autosaves every 2 seconds.
2. **Ready** — Mark ready when reviewed. A slug is required to advance from draft.
3. **Published** — Mark as published after copying to your platform. The post moves to the published archive.

Posts can be moved backward (Published → Ready → Draft) at any time.

While you edit, the left-hand post list updates the affected entry in place instead of reloading every section from scratch. The published archive still loads in pages via “Load more…”.

## API routes

All workspace-scoped routes are prefixed with `/api/w/:wsId/`. Workspace management routes are at `/api/workspaces`.

| Route | Description |
|---|---|
| `GET /api/workspaces` | List all workspaces |
| `POST /api/workspaces` | Create a workspace |
| `PUT /api/workspaces/:id` | Update a workspace |
| `DELETE /api/workspaces/:id` | Delete a workspace |
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
| `GET /api/w/:wsId/assets/:postId` | List assets |
| `POST /api/w/:wsId/assets/:postId` | Upload an asset |
| `DELETE /api/w/:wsId/assets/:postId/:filename` | Delete an asset |
| `GET /api/w/:wsId/assets/:postId/:filename/raw` | Serve raw asset file |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Cmd/Ctrl + N | New post |
| Cmd/Ctrl + E | Export |
| Cmd/Ctrl + Enter | Run AI analysis |
| Cmd/Ctrl + 1 | Switch to AI Analysis tab |
| Cmd/Ctrl + 2 | Switch to Assets tab |
| Cmd/Ctrl + 3 | Switch to Preview tab |
| Cmd/Ctrl + 4 | Switch to Metadata tab |

## License

MIT — © 2026 Yoshinao Inoguchi
