<div align="center">

# ✨ LumiMuse

**Let them slowly fill your room.**

*A quiet, elegant AI companion — built for those who want something that feels real.*

[![Next.js](https://img.shields.io/badge/Next.js_16-black?style=flat-square&logo=next.js)](https://nextjs.org)
[![React](https://img.shields.io/badge/React_19-61DAFB?style=flat-square&logo=react&logoColor=222)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS_v4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://www.sqlite.org)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-a78bfa?style=flat-square)](LICENSE)

English · [中文](README.md)

</div>

---

> LumiMuse is an AI companion app focused on the feeling of presence. It's not just about sending messages — it's about characters, long-term memory, context summarization, image generation, mobile experience, and data ownership, all coming together into a private space for lasting companionship.
>
> Create characters with unique personalities, backgrounds, greetings, example dialogues, and image generation tags. Let them gradually remember details about you, your relationship, and shared experiences. Runs locally or self-hosted via Docker — your characters, conversations, memories, and generated images all stay on your own device or server.

---

## Preview

| Home | Chat |
|------|------|
| ![Home](assets/首页.png) | ![Chat](assets/对话.png) |

| Character Editor | Memory Management | Settings |
|------|------|------|
| ![Character Editor](assets/编辑角色.png) | ![Memory Management](assets/记忆管理.png) | ![Settings](assets/设置.png) |

---

## Features at a Glance

| | Feature | Description |
|:---:|------|------|
| 🎭 | **Character System** | Unique personality, greeting, example dialogue, image tags — each character has independent conversations and memories, with drag-to-reorder |
| 💬 | **Chat Experience** | Streaming output, message edit/delete/multi-version regeneration, image & text attachments, manual summarization |
| 🧠 | **Long-term Memory** | Extract, review, profile, archive, and index memories with local working memory, vector retrieval, AI review, and memory profiles |
| 🎨 | **AI Image Generation** | SD WebUI / NovelAI / ComfyUI / Custom API support, with version history and image management |
| 🔌 | **Multi-provider** | Save multiple API configs and switch with one click; pick a model per chat right from the input bar |
| 🔍 | **Search & Navigation** | Global message search, date search, CJK inclusive search, jump-to-result with highlight |
| 📦 | **Import & Export** | Export characters, memories, and conversation records on demand; can import SillyTavern-style character card JSON |
| 🧹 | **Maintenance Panel** | Built into Settings — orphan-file detection & cleanup; deleting a character/conversation also cleans up its avatars, generated images, and attachments |
| 📱 | **Mobile** | Responsive layout, iOS safe-area support, touch-optimized interactions |
| 🔒 | **Access Protection** | Optional password, signed token + constant-time comparison + SSRF guard, public-deployment friendly |

---

## Feature Details

### 🎭 Character System

- Create, edit, and delete characters
- Configure avatar, personality, scenario, greeting, example dialogue, and system prompt
- Image generation tag field — save character art style, appearance, and fixed elements alongside the character
- Each character has independent conversations and memories, suitable for maintaining different relationship arcs
- Drag-to-reorder in the sidebar so frequently used characters can stay on top
- Import SillyTavern-style character card JSON (JSON files only — PNG-embedded cards are not supported); common fields like name, description, personality, scenario, greeting, example dialogue, system prompt, and tags are mapped over

### 💬 Chat Experience

- Streaming and non-streaming output
- Stop generation to prevent runaway requests or unwanted replies
- Edit, delete, regenerate messages with multi-version switching
- Regeneration preserves old versions — history is never silently overwritten
- Plain text, image attachments, and text attachments
- Image attachments enter context as multimodal content; text attachments are appended to context
- Duplicate conversations, refresh messages per conversation
- Manual context summarization to compress long history and reduce token usage

### 🧠 Long-term Memory

- Extract long-term memories from conversations, written to each character's memory bank
- Memory categories: relationship dynamics, topic history, basic info, preferences & habits, personality traits, important events
- Three configurable trigger modes: message count, fixed time interval, keyword — each can be toggled independently
- Configure whether to inject memories into chat context, and limit the maximum number injected
- Memory management page with pagination, search, category filtering, sorting, editing, deletion, and tag management
- Ignore memory extraction for individual conversations — avoid polluting the memory bank with test or off-topic chats
- Enhanced memory engine with local working memory, memory profiles, embedding-based vector indexes, and reranker support; external enhancement can be disabled for privacy
- Settings includes memory index status, rebuild index, index unindexed memories, retry failed index tasks, stop current indexing, and clear index actions
- AI review can batch-check active memories, correct category, importance, emotional weight, and tags, then automatically rebuild affected indexes
- AI archive can compress older memories into summary memories; archived memories remain traceable by batch, and summary memories are indexed automatically
- Memory profiles support initialization from memories, queued processing, manual edits, version switching, and version deletion for long-running relationship state
- Background tasks can use a separate provider and model; when DeepSeek is used in background tasks, reasoning can be disabled for faster AI review, profile updates, archive, summarization, and image prompt generation

### 🎨 AI Image Generation

- Four engines: Stable Diffusion WebUI, NovelAI, ComfyUI, Custom API
- Global quality tags, negative prompts, dimensions, sampler, steps, and other common parameters
- Generate image prompts from chat messages
- Auto-trigger keywords like "draw", "generate", "make one", "show me"
- Image version history — regeneration never discards old images
- In-conversation image preview, previous/next switching, delete current version
- Bulk delete and version retention in character image management
- Placeholder and progress hints during generation; old images are kept on failure to avoid accidental loss

### 🔌 Multi-provider Configuration

- Settings page lets you save multiple API configs (different providers, models, keys)
- The chat input bar can switch the model used for the current session, making A/B comparisons easy
- Switching providers does not modify existing message history

### 🔍 Search & Navigation

- Global search across all chat messages
- Paginated search results to prevent lag with large result sets
- CJK inclusive search to reduce missed results from Chinese word segmentation
- Date search: e.g. `2026-04-01`, `2026/4/1`, `2026.4.1`
- Jump directly from search results to the original message with highlight

### 📦 Import & Export

- Export characters, memories, conversation records, and messages
- Choose what to export — lightweight backup or full migration
- Import backup files for easy migration between local and server environments
- Import SillyTavern-style character card JSON for common fields (JSON only — PNG-embedded metadata is not parsed; extension fields like character book or detailed parameters may not round-trip cleanly)
- SQLite database (single-file), automatically saved at `data/lumimuse.db`

### 🧹 Maintenance Panel

- The Settings page contains a Maintenance section that can manually scan for orphan files (avatars / generated images / attachments no longer referenced by any character or message)
- One-click cleanup after scanning, so unused files don't pile up after long-term use
- Deleting a character or conversation also cleans up its associated images and attachments — no leftovers

### 📱 Mobile & Desktop

- Responsive layout for both wide desktop screens and narrow phone screens
- `h-dvh` for iOS Safari address bar adaptation
- Safe-area handling to prevent input fields from being obscured by system gesture areas
- Tap to show/hide images and message action buttons on touch devices
- Compact layout optimization for memory cards, toolbars, and conversation switcher drawer on mobile

### 🔒 Access Protection

- Optional `ACCESS_PASSWORD` for access protection
- Without a password, the app is accessible without login — ideal for personal use on your own computer
- Setting a password is strongly recommended when deploying to the public internet
- After login, the app issues an HMAC-SHA256 signed token (the password is no longer stored in the cookie). Set `AUTH_SECRET` to keep tokens valid across multiple replicas
- Password verification uses constant-time comparison to prevent timing attacks
- `X-Forwarded-For` is not trusted by default; set `TRUST_PROXY=1` only when a trusted reverse proxy overwrites forwarded headers and the application port must not be reachable directly. One nearest proxy hop is trusted by default; set positive `TRUST_PROXY_HOPS` for a longer chain, parsed from the right of XFF
- Outbound requests (image generation, model list, summarization, chat completion) go through an SSRF guard with DNS resolution and per-redirect re-validation, so external URLs cannot be redirected toward your internal network
- Self-hosting local LLM / SD WebUI? Set `ALLOW_LOCAL_NETWORK=1` to allow loopback, RFC1918, IPv6 ULA/site-local, and `100.64.0.0/10` (CGNAT/overlay). Metadata/link-local, multicast, documentation, benchmark, and reserved ranges remain blocked

---

## Tech Stack

| Layer | Technology |
|:---:|------|
| Framework | Next.js 16 (React full-stack framework) |
| Frontend | React 19 (UI component library) |
| Language | TypeScript (typed JavaScript) |
| Styling | Tailwind CSS v4 (utility-first CSS framework) |
| Database | SQLite + better-sqlite3 (local single-file database & Node.js driver) |
| AI | OpenAI Chat Completions API format (multi-provider config switching) |
| Fonts | Quicksand + LXGW WenKai Screen |
| Container | Docker + Docker Compose (container deployment tools) |

---

## Getting Started

### Requirements

- Node.js **>=20.18.1**
- npm (bundled with Node.js)
- A model service compatible with the OpenAI Chat Completions API format
- For Docker deployment: Docker and Docker Compose

CI verifies the project on Ubuntu with Node **20.18** / **Node 24**, plus Windows with Node **20.18** (covering the `Start.bat` surface and the better-sqlite3 native module); locally, use Node 20.18.1 or newer.

### Run Locally

```bash
git clone https://github.com/in30mn1a/LumiMuse.git
cd LumiMuse
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), go to Settings, and enter your model API information to get started.

The database is created automatically at `data/lumimuse.db`.

### Local Production Start

```bash
npm run build
npm run start:local
```

`npm run start:local` uses Next.js `next start` (the Next.js production server), which is the local source-tree check for a production build.

`npm start` is equivalent to `npm run start:standalone` and runs `.next/standalone/server.js` to check the Next.js standalone output. The Docker image copies `.next/standalone` into the container work directory and runs `node server.js` inside the container.

### Windows Quick Start

A `Start.bat` file is provided in the project root. If you've already installed dependencies, double-click it to launch LumiMuse.

---

## First-time Setup

### 1️⃣ Configure Model API

Go to Settings and fill in:

- `API Base` — API endpoint URL, e.g. `https://api.openai.com/v1`, or your proxy / local model address
- `API Key` — Model service API key
- `Model` — Model name, e.g. the chat model name provided by your service
- `Temperature` — Higher values produce more creative responses, lower values more consistent ones
- `Max Tokens` — Maximum number of tokens per response
- `Context Window` — Approximate maximum token count the model can accept

After filling in, you can fetch the model list from the model selector (if your provider supports it), or manually enter a model name.

### 2️⃣ Create a Character

Create a character from the sidebar. At minimum, consider filling in:

- **Name** — Character display name
- **Greeting** — First message when starting a new conversation
- **Personality / Scenario** — Helps the character maintain a consistent persona
- **System Prompt** — Explicitly tells the AI how to role-play
- **Image Tags** — If you plan to use image generation, include character appearance and art style tags

### 3️⃣ Start Chatting

Select a character to create a conversation. You can:

- Send text directly
- Upload images for vision-capable models to read
- Upload text attachments as context
- Regenerate unsatisfying replies and switch between versions
- Manually summarize context in long conversations to reduce model burden

### 4️⃣ Manage Memories

Go to the Memory Management page to view what a character has remembered. It's a good idea to periodically review and organize memories:

- Delete incorrect or unwanted memories
- Edit inaccurately described memories
- Add tags for easier future searching
- Filter by category or keyword

---

## Docker Deployment

### 1. Prepare Environment Variables

Copy the example environment file:

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```env
# Access password (strongly recommended when deploying to the public internet)
ACCESS_PASSWORD=your_password_here

# Optional: HMAC token signing secret (derived from ACCESS_PASSWORD by default)
# Set this explicitly for multi-replica deployments or to keep cookies valid across restarts
# AUTH_SECRET=use_a_long_random_string_here

# Optional: enable only when a trusted reverse proxy overwrites X-Forwarded-For
# TRUST_PROXY=1

# Optional: TRUST_PROXY=1 trusts the nearest proxy by default; use a positive value for more hops
# The application port must not be reachable directly around the trusted proxy
# TRUST_PROXY_HOPS=2

# Optional: explicitly allow private network addresses for self-hosted local LLM / SD WebUI
# ALLOW_LOCAL_NETWORK=1
```

Without `ACCESS_PASSWORD`, the app won't require login. This mode is only recommended for personal use on your own computer or a trusted LAN; production Docker startup fails fast when the password is empty or still set to a placeholder such as `your_password_here`.

`docker-compose.yml` reads `.env.local` through `env_file` by default, so the `ACCESS_PASSWORD` / `AUTH_SECRET` values above are injected into the container environment. You do not need an extra `docker compose --env-file ...` flag. To use another file, run `LUMIMUSE_ENV_FILE=.env.production docker compose up -d --build`.

### 2. Start the Service

```bash
docker compose up -d --build
```

Visit [http://localhost:3000](http://localhost:3000) after startup.

### 3. Persistent Data

`docker-compose.yml` mounts the following directories by default:

| Host Directory | Container Directory | Purpose |
|------|------|------|
| `./data` | `/app/data` | SQLite database |
| `./public/generated` | `/app/public/generated` | Generated images |
| `./public/avatars` | `/app/public/avatars` | Character avatars |
| `./public/attachments` | `/app/public/attachments` | Conversation attachments (images / text) |

As long as these directories remain, data survives container rebuilds. The container runs as a non-root user (UID 1001:1001) to reduce attack surface, and the entrypoint no longer runs `chown` automatically. On Linux, when using bind mounts like `./data`, run `sudo chown -R 1001:1001 data public/generated public/avatars public/attachments` once before the first startup. If you switch to Docker named volumes, Docker initializes the volume from the image-owned directories, so manual permission repair is usually unnecessary.

On Windows / macOS, Docker Desktop handles permissions automatically — `docker compose up -d --build` is enough.

### 4. Update

```bash
git pull
docker compose up -d --build
```

Before updating, export a backup from within the app or manually back up `data/`, `public/generated/`, `public/avatars/`, and `public/attachments/`.

Container health has two endpoints: `/api/health` reports process liveness only, while `/api/health?ready=1` also checks SQLite and all four persistent directories for writability. CI images expose the full commit SHA in the `build` field; a standard local Compose build defaults that field to `local`. To make a self-built image traceable, set `LUMIMUSE_BUILD_SHA` to the full output of `git rev-parse HEAD` before building. If the container stays unready, inspect `docker compose logs lumimuse`, then check UID/GID 1001 mount ownership, free disk space, and all four mounted directories. Compose rotates container logs at three 10MB files by default.

---

## Image Generation Setup

Go to Settings and enable image generation, then choose an engine.

### Stable Diffusion WebUI

For users running Stable Diffusion WebUI locally.

- Default address: `http://127.0.0.1:7860`
- Requires WebUI API to be enabled
- Configurable: model, sampler, steps, CFG Scale, dimensions, negative prompt

> ⚠️ If LumiMuse runs in a Docker container while SD WebUI runs on the host, `127.0.0.1` refers to the container itself — not the host. Use the host's LAN IP or another accessible address instead.

### NovelAI

For users with a NovelAI image generation API subscription.

- Requires a NovelAI API Key
- Configurable: model, sampler, noise schedule, steps, scale, dimensions, negative prompt, artist tags

### ComfyUI

For users with existing ComfyUI workflows.

- Default address: `http://127.0.0.1:8188`
- Requires a workflow JSON
- Ensure the prompt and output nodes in your workflow are compatible with the project's expectations

### Custom API

For OpenAI DALL·E format or other compatible image generation endpoints.

- Fill in the custom API endpoint URL
- If authentication is required, enter the API Key
- Configure model name and image dimensions

---

## Memory System

LumiMuse's memory system doesn't simply dump all chat history back into context. It works in two steps — extraction and injection:

1. **Extract** — When trigger conditions are met, a background task summarizes conversation content worth preserving long-term
2. **Manage** — Memories enter the character's memory bank, where you can manually edit, delete, and tag them
3. **Inject** — Next time you chat, the system retrieves relevant memories and includes them in context, so the character "remembers"

Configurable options include:

- Whether to enable memory injection
- Message count trigger: e.g. attempt extraction every 3 messages
- Time trigger: e.g. attempt extraction every 24 hours
- Keyword trigger: e.g. trigger when "good night" appears
- Maximum injection count: limit how many memories are included per chat

If a conversation is just for testing prompts or chatting off-topic, you can set it to ignore memory extraction to avoid polluting the character's memory bank.

---

## Data & Privacy

LumiMuse stores all core data on your own machine or server:

- SQLite database: `data/lumimuse.db`
- Generated images: `public/generated/`
- Character avatars: `public/avatars/`
- Conversation attachments: `public/attachments/`

The app itself does not upload your characters, conversations, or memories to any LumiMuse author's server. The only outbound requests come from the model API and image generation API you configure yourself.

When deploying to the public internet, be sure to:

- Set `ACCESS_PASSWORD`
- Make sure `ACCESS_PASSWORD` is not empty and not an example placeholder; production Docker startup refuses those values
- Use HTTPS — preferably behind a reverse proxy
- Set `TRUST_PROXY=1` only when your trusted reverse proxy overwrites forwarded headers and the application port must not be reachable directly; configure multiple trusted hops with `TRUST_PROXY_HOPS`
- Regularly back up `data/`, `public/generated/`, `public/avatars/`, and `public/attachments/`
- Never commit `.env.local`, database files, or personal backups to a public repository

---

## Backup & Migration

The recommended approach is using the in-app export/import functionality:

1. Go to the memory management or relevant export page in the old environment
2. Select what to export — e.g. characters, memories, and conversation records
3. Download the backup file
4. Import the backup file in the new environment
5. Verify that characters, conversations, and memories look correct

If you're comfortable with file-level backups, you can also directly back up these directories:

```text
data/
public/generated/
public/avatars/
public/attachments/
```

Database migrations record SQLite `user_version`. Before downgrading, stop the app and make a complete backup of every directory above. Builds that include the schema-version guard fail fast when they see a newer schema, but historical builds from before that guard do not have this protection. Do not roll back by manually lowering `user_version`; restore a database and asset backup that matches the older build instead.

---

## FAQ

<details>
<summary><strong>Why can't I chat after opening the app?</strong></summary>

Usually the model API isn't configured properly. Check that `API Base`, `API Key`, and `Model` in Settings are correct, and confirm your model service supports the OpenAI Chat Completions API format.

</details>

<details>
<summary><strong>Why does the model list fetch fail?</strong></summary>

Some providers don't offer a model list endpoint, or their endpoint path differs from OpenAI's. In this case, you can manually enter the model name.

</details>

<details>
<summary><strong>Why can't Docker access my local image generation service?</strong></summary>

Inside a container, `127.0.0.1` refers to the container itself — not your host machine. Use the host's LAN IP or configure an accessible service address in the Docker network.

</details>

<details>
<summary><strong>Why don't memories appear immediately?</strong></summary>

Memory extraction is a background task that runs when trigger conditions are met. Check your memory trigger settings, or wait a moment and refresh the memory management page.

</details>

<details>
<summary><strong>Why do Chinese search results differ from English?</strong></summary>

Chinese text doesn't have natural word boundaries. The project uses inclusive search for Chinese keywords to reduce missed results. For complex keywords, try shorter terms.

</details>

<details>
<summary><strong>Which models can I use?</strong></summary>

Any service compatible with the OpenAI Chat Completions API format should work — OpenAI, DeepSeek, various proxy services, local model gateways, etc. Support for images, multimodal input, JSON mode, and context length varies by model.

</details>

---

## Project Structure

```text
LumiMuse/
├─ src/
│  ├─ app/                 # Next.js pages & API routes
│  ├─ components/          # Chat, sidebar, search, memory UI components
│  ├─ hooks/               # Custom React hooks (reusable state logic)
│  ├─ lib/                 # Database, AI requests, memory, time, i18n core logic
│  └─ types/               # TypeScript type definitions
├─ public/
│  ├─ avatars/             # Character avatars
│  ├─ generated/           # Generated images
│  └─ attachments/         # Conversation attachments (images / text)
├─ data/                   # SQLite database directory
├─ Dockerfile              # Docker image build config
├─ docker-compose.yml      # Docker Compose deployment config
└─ README.md
```

---

## Development

`Start.bat` is a Windows local-development shortcut, not a production service manager. Before committing or deploying, run the same full validation sequence used by CI:

The Next.js-scoped PostCSS override in `package.json` is intentional security hardening. It replaces only Next's transitive copy until upstream ships an equal or newer fix. After upgrading Next, inspect the tree with `npm explain postcss` and verify cleanup with `npm prune --dry-run`; do not hide lockfile problems by deleting `node_modules`.

```bash
npm run lint
npm test
npm run regression
npm run build
```

---

<div align="center">

[MIT](LICENSE) © 2026 in30mn1a

</div>
