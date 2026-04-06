# BigMouth

A local-first writing preflight tool for composing and reviewing blog posts and social media content before publishing.

## What it does

BigMouth is a single-user desktop-style web app (Node.js backend + React frontend) that runs entirely on your machine. You write posts in Markdown, run AI-powered quality and safety checks, generate metadata, and export when ready. There is no sync, no cloud storage, and no direct publishing — you copy and paste to your platform of choice.

## Features

- **Markdown editor** with autosave and resizable panes
- **Three-stage workflow**: Draft → Ready → Published
- **AI analysis** — run named prompts against post content to catch issues before publishing
- **AI metadata generation** — generate title, slug, tags, SEO description, and more with one click
- **Assets** — upload and manage images and files per post; embed links directly in the editor
- **Export** — copy post content as HTML or plain text
- **Multi-language support** — write in any language; generate English supplement fields for non-English posts
- **Targets** — configure multiple publishing destinations with per-target metadata requirements
- **Source linking** — link a post to a source post (e.g. a translation derived from an original)
- **Navigation history** — back-navigate through linked posts

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

The server starts on `http://localhost:3141` by default. Open that URL in your browser.

## Data directory

All data is stored locally under `~/.bigmouth/`:

```
~/.bigmouth/
  app.json                    ← points to the active data directory
  data/
    posts/
      drafts/                 ← draft posts (.md files)
      ready/                  ← ready-to-publish posts (.md files)
      published/              ← published posts (.md files)
    assets/
      {postId}/               ← per-post uploaded files + meta.json
    logs/                     ← server log files
    settings.json
    ai-configs.json
    targets.json
    analysis-prompts.json
    generation-prompts.json
```

Each post is a Markdown file with YAML front matter. The filename encodes the slug (ready/published posts) or the post ID (drafts).

## Configuration

### Settings (`settings.json`)

| Field | Default | Description |
|---|---|---|
| `port` | `3141` | Local server port |
| `timezone` | system | IANA timezone (e.g. `"Asia/Tokyo"`) |
| `supportedLanguages` | `["en"]` | ISO 639-1 codes shown in language selects |
| `publishedPostsPerLoad` | `50` | How many published posts to load per page |
| `maxUploadMb` | `500` | Max asset upload size in MB |
| `editorWatermark` | — | Placeholder shown in an empty editor |
| `extraFieldWatermark` | — | Placeholder shown in the extra metadata field |

### Targets (`targets.json`)

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

### AI configuration

AI providers are configured through the Settings UI. Currently supported: **Claude (Anthropic)**. API keys are stored obfuscated in `ai-configs.json`.

### Analysis prompts (`analysis-prompts.json`)

Named prompts for AI content review. Use `{content}` as a placeholder — text before it becomes the system prompt; the post content becomes the user message. If `{content}` is omitted, the full prompt is used as the system prompt.

### Generation prompts (`generation-prompts.json`)

Prompts used to auto-generate individual metadata fields (title, slug, tags, etc.). A shared preamble is prepended to each field-specific prompt.

## Post workflow

1. **Draft** — Create a post, pick a target and language. Write in Markdown. Content autosaves every 2 seconds.
2. **Ready** — Mark ready when reviewed. A slug is required to advance from draft.
3. **Published** — Mark as published after copying to your platform. The post moves to the published archive.

Posts can be moved backward (Published → Ready → Draft) at any time.

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
