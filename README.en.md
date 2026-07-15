<div align="center">

<img src="public/icons/icon-192x192.png" alt="LumiMuse" width="96" height="96" />

# ✨ LumiMuse

**Let them slowly fill your room.**

*A quiet, elegant AI companion — built for those who want something that feels real.*

<br/>

[![Next.js](https://img.shields.io/badge/Next.js_16-black?style=for-the-badge&logo=next.js)](https://nextjs.org)
[![React](https://img.shields.io/badge/React_19-61DAFB?style=for-the-badge&logo=react&logoColor=222)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind](https://img.shields.io/badge/Tailwind_v4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://www.sqlite.org)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-a78bfa?style=for-the-badge)](LICENSE)

<br/>

**English** · [中文](README.md)

<br/>

| Local | One-command Docker | Your data stays yours |
|:---:|:---:|:---:|
| `npm run dev` | `docker compose up` | SQLite + local files |

</div>

---

## Table of Contents

- [About](#about)
- [Why LumiMuse?](#why-lumimuse)
- [Preview](#preview)
- [Features at a Glance](#features-at-a-glance)
- [Feature Details](#feature-details)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [First-time Setup](#first-time-setup)
- [Docker Deployment](#docker-deployment)
- [Image Generation Setup](#image-generation-setup)
- [Memory System](#memory-system)
- [Data & Privacy](#data--privacy)
- [Backup & Migration](#backup--migration)
- [FAQ](#faq)
- [Project Structure](#project-structure)
- [Development](#development)

---

## About

LumiMuse is a lightweight AI role-play / companion system with long-term memory, real-world time injection, built-in image generation, import/export, and Docker deployment.

It isn't trying to become a giant platform that stuffs everything in. It aims to be a quiet, good-looking private companion space you can actually live with for a long time.

Create characters with personality, background, greeting, example dialogue, and image tags. Let them gradually remember details about you, your relationship, and the things you've been through together. Everything stays on your machine or your own server.

---

## Why LumiMuse?

### Lightweight RP — start chatting without a complex setup

Some RP tools are powerful, but also heavy.

Presets, world books, plugins, extensions, character cards, chat files, databases… Getting started can feel like configuring a whole engineering project.

LumiMuse isn't trying to replace deep, complex workflows. It offers a lighter, more intuitive path:

1. Create a character
2. Fill in the persona
3. Configure a model API
4. Start chatting
5. Let memory slowly settle the relationship

If you just want to live with a character over time — not spend half an hour tuning settings every day — LumiMuse is probably a better fit.

### Automatic memory — they remember what happened between you

LumiMuse has a built-in long-term memory system. It doesn't just dump the entire chat history back into context.

As you talk, it extracts details worth keeping and writes them into the character's memory bank — relationship dynamics, topic history, preferences and habits, personality traits, important events.

Next time you chat, relevant memories are injected into context so the character can more naturally "remember" what came before.

### Real-world time injection — they know what time it is

LumiMuse can inject the current real-world time into chat context.

Characters can tell day from night, and feel time passing. They might say good night when you're chatting in the evening, or notice that it's been a few days since you last talked.

For long-term companion RP, a sense of time matters.  
With time, a character feels more like they're living alongside you.

### Built-in image generation — no need to jump between tools

LumiMuse has native AI image generation. You can create images from chat content or character settings directly.

Supported engines:

- Stable Diffusion WebUI
- NovelAI
- ComfyUI
- Custom image generation APIs

Save appearance, outfit, and art-style tags on each character. When a scene comes up, generate a picture without leaving the conversation.

### Multi-device — works on desktop and phone

LumiMuse is built with a responsive layout.

Desktop is comfortable for long chats and organizing characters and memories; mobile is adapted on purpose, not just a desktop page squeezed onto a small screen. Tablet portrait/landscape, iOS safe areas, font size, and font style are all considered.

### Your data stays yours

Characters, conversations, memories, and generated images live on your machine or server.  
Import/export makes backup and migration easy; Docker lets you deploy on hardware you control.

---

## Preview

<table>
  <tr>
    <td align="center" width="50%">
      <img src="assets/首页.png" alt="Home" />
      <br/><sub>Home</sub>
    </td>
    <td align="center" width="50%">
      <img src="assets/对话.png" alt="Chat" />
      <br/><sub>Chat</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <img src="assets/编辑角色.png" alt="Character Editor" />
      <br/><sub>Character Editor</sub>
    </td>
    <td align="center" width="33%">
      <img src="assets/记忆管理.png" alt="Memory Management" />
      <br/><sub>Memory Management</sub>
    </td>
    <td align="center" width="33%">
      <img src="assets/设置.png" alt="Settings" />
      <br/><sub>Settings</sub>
    </td>
  </tr>
</table>

---

## Features at a Glance

| | Feature | Description |
|:---:|:---|:---|
| 🎭 | **Character System** | Unique personality, greeting, example dialogue, image tags — independent conversations & memories per character, drag-to-reorder, SillyTavern JSON import |
| 💬 | **Chat Experience** | Streaming, edit / delete / multi-version regenerate, image & text attachments, manual summarization, real-world time injection |
| 🧠 | **Long-term Memory** | Extract, AI review, profile, archive, and index — local working memory + vector retrieval + reranker + token-budget packing |
| 🎨 | **AI Image Generation** | SD WebUI / NovelAI / ComfyUI / Custom API, version history, auto-trigger keywords |
| 🔌 | **Multi-provider** | Save multiple API configs; switch models right from the chat input bar |
| 🔍 | **Search & Navigation** | Global message search, date search, CJK inclusive search, jump-to-result with highlight |
| 📦 | **Import & Export** | Export characters / memories / conversations on demand — lightweight backup or full migration |
| 🧹 | **Maintenance Panel** | Orphan-file detection & cleanup; deleting a character/conversation also cleans related files |
| 📱 | **Multi-device UX** | Responsive layout, iPad portrait/landscape, iOS safe-area, font size & style settings |
| 🔒 | **Access Protection** | Optional password, HMAC signed token, constant-time comparison, SSRF guard |

---

## Feature Details

### 🎭 Character System

- Create, edit, and delete characters
- Configure avatar, personality, scenario, greeting, example dialogue, and system prompt
- Image generation tag field — save art style, appearance, and fixed elements with the character
- Each character has independent conversations and memories
- Drag-to-reorder in the sidebar
- Import SillyTavern-style character card JSON (JSON only — PNG-embedded cards are not supported)

### 💬 Chat Experience

- Streaming and non-streaming output, with stop generation
- Edit, delete, regenerate messages with multi-version switching; old versions are preserved
- Plain text, image attachments, and text attachments
- Image attachments enter context as multimodal content; text attachments are appended
- Duplicate conversations, refresh messages per conversation
- Manual context summarization to compress long history
- Real-world time injection so characters can sense the current moment and time passing
- Recent chats in the header; mobile toolbar expands by default for faster switching

### 🧠 Long-term Memory

- Extract long-term memories from conversations into each character's memory bank
- Categories: relationship dynamics, topic history, basic info, preferences & habits, personality traits, important events
- Three trigger modes: message count, time interval, keyword — each toggleable
- Enhanced engine: local working memory, memory profiles, embedding vector indexes, and reranker support
- Injection packs memories by token budget (default `memory_package_token_budget = 12000`), preferring high-relevance / high-priority items
- Memory management page with pagination, search, category filters, sorting, editing, deletion, and tags
- Ignore memory extraction per conversation to avoid polluting the bank with test chats
- AI review can batch-correct category, importance, emotional weight, and tags, then rebuild affected indexes
- AI archive compresses older memories into summary memories with traceable batches
- Memory profiles support init, queued processing, manual edits, version switching, and version deletion
- Background tasks can use a separate provider/model; DeepSeek background reasoning can be disabled for faster review / profile / archive work
- Settings includes index status, rebuild, index unindexed, retry failed, stop current job, and clear index

### 🎨 AI Image Generation

- Four engines: Stable Diffusion WebUI, NovelAI, ComfyUI, Custom API
- Global quality tags, negative prompts, dimensions, sampler, steps, and more
- Generate prompts from chat messages; auto-trigger keywords supported
- Image version history — regeneration never silently discards old images
- In-conversation preview, previous/next switching, delete current version
- Bulk delete and version retention in character image management
- Placeholder and progress during generation; old images kept on failure

### 🔌 Multi-provider Configuration

- Save multiple API configs (providers, models, keys)
- Temporarily switch the model for the current session from the chat input bar
- Switching providers does not modify existing message history

### 🔍 Search & Navigation

- Global search across chat messages with paginated results
- CJK inclusive search to reduce missed Chinese matches
- Date search: e.g. `2026-04-01`, `2026/4/1`, `2026.4.1`
- Jump from results to the original message with highlight

### 📦 Import & Export

- Export characters, memories, conversation records, and messages
- Choose what to export — lightweight backup or full migration
- Import backup files for local ↔ server moves
- SillyTavern-style character card JSON for common fields (JSON only; extension fields like character book may not round-trip fully)
- SQLite database at `data/lumimuse.db`

### 🧹 Maintenance Panel

- Scan for orphan files (avatars / generated images / attachments no longer referenced)
- One-click cleanup after scanning
- Deleting a character or conversation also cleans associated images and attachments

### 📱 Multi-device Experience

- Responsive layout for desktop, tablet, and phone
- iPad / tablet portrait and landscape layout improvements
- `h-dvh` for iOS Safari address-bar adaptation
- Safe-area handling so the input isn't covered by system gesture areas
- Tap to show/hide images and message action buttons on touch devices
- Font style (WenKai / system / serif) and font size (small / medium / large) global scaling
- Light/dark theme and Chinese/English UI

### 🔒 Access Protection

- Optional `ACCESS_PASSWORD`; without it the app is open — fine for personal machines
- Strongly recommended when deploying to the public internet
- After login, issues an HMAC-SHA256 signed token; set `AUTH_SECRET` for multi-replica token stability
- Constant-time password comparison
- `X-Forwarded-For` is not trusted by default; set `TRUST_PROXY=1` only when a trusted reverse proxy overwrites forwarded headers and the app port is not directly reachable
- Outbound requests (image gen, model list, summarization, chat completion) go through an SSRF guard
- Self-hosting local LLM / SD WebUI? Set `ALLOW_LOCAL_NETWORK=1` to allow private network addresses

---

## Tech Stack

| Layer | Technology |
|:---:|:---|
| Framework | Next.js 16 (App Router, `output: "standalone"`) |
| Frontend | React 19 |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS v4 |
| Database | SQLite + better-sqlite3 (WAL) |
| AI | OpenAI Chat Completions–compatible APIs |
| Fonts | Quicksand + LXGW WenKai Screen |
| Container | Docker + Docker Compose |

---

## Getting Started

### Requirements

- Node.js **>= 20.18.1**
- npm
- A model service compatible with the OpenAI Chat Completions API format
- Docker & Docker Compose for container deployment

CI verifies Ubuntu (Node **20.18** / **24**) and Windows (Node **20.18**). Locally, use Node 20.18.1 or newer.

### Run Locally

```bash
git clone https://github.com/in30mn1a/LumiMuse.git
cd LumiMuse
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), go to Settings, and enter your model API details.

The database is created automatically at `data/lumimuse.db`.

### Local Production Start

```bash
npm run build
npm run start:local
```

| Command | Purpose |
|:---|:---|
| `npm run start:local` | Uses `next start` — local source-tree production check |
| `npm start` / `npm run start:standalone` | Runs `.next/standalone/server.js` — same path Docker uses |

### Windows Quick Start

A `Start.bat` file is provided in the project root. After installing dependencies, double-click it to launch LumiMuse.

---

## First-time Setup

### 1️⃣ Configure Model API

Go to Settings and fill in:

| Field | Description |
|:---|:---|
| `API Base` | Endpoint URL, e.g. `https://api.openai.com/v1`, or your proxy / local model address |
| `API Key` | Model service API key |
| `Model` | Model name |
| `Temperature` | Higher = more creative; lower = more consistent |
| `Max Tokens` | Max tokens per response |
| `Context Window` | Approximate max context tokens the model accepts |

You can try fetching the model list; if the provider doesn't support it, enter the model name manually.

### 2️⃣ Create a Character

At minimum, consider filling in:

- **Name** — display name
- **Greeting** — first message of a new conversation
- **Personality / Scenario** — keeps the persona stable
- **System Prompt** — tells the AI how to role-play
- **Image Tags** — appearance and art style if you use image generation

### 3️⃣ Start Chatting

Select a character to create a conversation:

- Send text
- Upload images (vision-capable models)
- Upload text attachments as context
- Regenerate replies and switch between versions
- Manually summarize long conversations

### 4️⃣ Manage Memories

Open Memory Management and periodically review:

- Delete incorrect or unwanted memories
- Edit inaccurate descriptions
- Add tags for easier search
- Filter by category or keyword

---

## Docker Deployment

### 1. Prepare Environment Variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```env
# Access password (strongly recommended on the public internet)
ACCESS_PASSWORD=your_password_here

# Optional: HMAC token signing secret (derived from ACCESS_PASSWORD by default)
# Set explicitly for multi-replica deployments or cookies that survive restarts
# AUTH_SECRET=use_a_long_random_string_here

# Optional: enable only when a trusted reverse proxy overwrites X-Forwarded-For
# TRUST_PROXY=1

# Optional: number of trusted proxy hops (default 1)
# TRUST_PROXY_HOPS=2

# Optional: allow private network addresses for self-hosted local LLM / SD WebUI
# ALLOW_LOCAL_NETWORK=1
```

> ⚠️ Without `ACCESS_PASSWORD`, login is not required — only recommended on your own machine or a trusted LAN. Production Docker startup fails fast on empty passwords or placeholders like `your_password_here`.

`docker-compose.yml` reads `.env.local` via `env_file` by default. To use another file:

```bash
LUMIMUSE_ENV_FILE=.env.production docker compose up -d --build
```

### 2. Start the Service

```bash
docker compose up -d --build
```

Visit [http://localhost:3000](http://localhost:3000) after startup.

### 3. Persistent Data

| Host Directory | Container Directory | Purpose |
|:---|:---|:---|
| `./data` | `/app/data` | SQLite database |
| `./public/generated` | `/app/public/generated` | Generated images |
| `./public/avatars` | `/app/public/avatars` | Character avatars |
| `./public/attachments` | `/app/public/attachments` | Conversation attachments |

The container runs as non-root **UID/GID 1001**. On Linux bind mounts, run once:

```bash
sudo chown -R 1001:1001 data public/generated public/avatars public/attachments
```

Docker Desktop on Windows / macOS usually needs no manual permission fix.

### 4. Update

```bash
git pull
docker compose up -d --build
```

Before updating, export a backup from the app or manually back up `data/` and `public/{generated,avatars,attachments}/`.

**Health checks**

| Endpoint | Meaning |
|:---|:---|
| `/api/health` | Process liveness |
| `/api/health?ready=1` | Liveness + SQLite and all four persistent dirs writable |

CI images put the full commit SHA in the health response `build` field; local Compose defaults to `local`. For self-built images, set `LUMIMUSE_BUILD_SHA=$(git rev-parse HEAD)`.

If the container stays unready, check `docker compose logs lumimuse`, then UID/GID 1001 ownership, disk space, and the four mount points.

---

## Image Generation Setup

Enable image generation in Settings, then choose an engine.

### Stable Diffusion WebUI

- Default address: `http://127.0.0.1:7860`
- Requires WebUI API enabled
- Configurable: model, sampler, steps, CFG Scale, dimensions, negative prompt

> ⚠️ If LumiMuse runs in Docker while SD WebUI runs on the host, `127.0.0.1` is the container — use the host LAN IP instead.

### NovelAI

- Requires a NovelAI API Key
- Configurable: model, sampler, noise schedule, steps, scale, dimensions, negative prompt, artist tags

### ComfyUI

- Default address: `http://127.0.0.1:8188`
- Requires a workflow JSON
- Ensure prompt and output nodes match what the project expects

### Custom API

- For OpenAI DALL·E–style or other compatible endpoints
- Fill in endpoint URL, optional API Key, model name, and image dimensions

---

## Memory System

LumiMuse does not dump all chat history back into context. The flow is:

```text
Extract → Manage / Review / Archive → Retrieve → Pack & Inject
```

1. **Extract** — When triggers fire, a background task summarizes content worth keeping long-term
2. **Manage** — Memories enter the character bank for manual edit/delete/tagging, or AI review/archive
3. **Retrieve** — Priority, keyword, optional vector search and reranking pick relevant memories
4. **Inject** — Pack by token budget into the system prompt so the character "remembers"

**Configurable options include:**

- Whether memory injection is enabled
- Message-count / time / keyword extraction triggers
- Enhanced memory engine and retrieval parameters
- `memory_package_token_budget` — token budget for the injected memory package (default 12000)
- Background model and reasoning effort
- Per-conversation ignore-extraction flag

If a conversation is only for testing prompts, mark it to ignore memory extraction so it doesn't pollute the bank.

> Design idea: **unlimited storage, limited activation**. Memories can grow forever; each turn only injects a relevant, ranked subset.

---

## Data & Privacy

Core data stays on your machine or server:

| Path | Content |
|:---|:---|
| `data/lumimuse.db` | SQLite database |
| `public/generated/` | Generated images |
| `public/avatars/` | Character avatars |
| `public/attachments/` | Conversation attachments |

The app does not upload your characters, conversations, or memories to any LumiMuse author server. Outbound requests mainly come from the model API and image API you configure yourself.

When deploying publicly:

- Set `ACCESS_PASSWORD` (not empty, not a placeholder)
- Use HTTPS, preferably behind a reverse proxy
- Set `TRUST_PROXY=1` only when a trusted proxy overwrites forwarded headers
- Regularly back up `data/` and `public/{generated,avatars,attachments}/`
- Never commit `.env.local`, database files, or personal backups to a public repo

---

## Backup & Migration

**Recommended: in-app export / import**

1. In the old environment, select what to export (characters, memories, conversations, …)
2. Download the backup file
3. Import it in the new environment
4. Verify characters, conversations, and memories look correct

**Or back up directories directly:**

```text
data/
public/generated/
public/avatars/
public/attachments/
```

Database migrations record SQLite `user_version`. Before downgrading, stop the app and fully back up the directories above. Do not roll back by manually lowering `user_version` — restore a database and asset backup that matches the older build.

---

## FAQ

<details>
<summary><strong>Why can't I chat after opening the app?</strong></summary>

<br/>

Usually the model API isn't configured. Check `API Base`, `API Key`, and `Model` in Settings, and confirm the service supports the OpenAI Chat Completions API format.

</details>

<details>
<summary><strong>Why does the model list fetch fail?</strong></summary>

<br/>

Some providers don't offer a model list endpoint, or the path differs from OpenAI's. Enter the model name manually.

</details>

<details>
<summary><strong>Why can't Docker reach my local image generation service?</strong></summary>

<br/>

Inside a container, `127.0.0.1` is the container itself — not the host. Use the host LAN IP or another reachable address. To allow private-network targets, set `ALLOW_LOCAL_NETWORK=1`.

</details>

<details>
<summary><strong>Why don't memories appear immediately?</strong></summary>

<br/>

Memory extraction is a background task that runs when triggers fire. Check your trigger settings, or wait a moment and refresh the memory page.

</details>

<details>
<summary><strong>Why do Chinese search results differ from English?</strong></summary>

<br/>

Chinese text has no natural word boundaries. The project uses inclusive search for Chinese keywords. For complex queries, try shorter terms.

</details>

<details>
<summary><strong>Which models can I use?</strong></summary>

<br/>

Any service compatible with the OpenAI Chat Completions API format should work — OpenAI, DeepSeek, proxy services, local model gateways, etc. Support for images, multimodal input, JSON mode, and context length varies by model.

</details>

<details>
<summary><strong>Where do I change font size / style?</strong></summary>

<br/>

In Settings you can switch font style (WenKai / system / serif) and font size (small / medium / large). Size scales the global rem system via the root `font-size`.

</details>

---

## Project Structure

```text
LumiMuse/
├─ src/
│  ├─ app/                 # Pages & API routes (App Router)
│  ├─ components/          # Chat, sidebar, search, memory, settings UI
│  ├─ hooks/               # Custom React hooks
│  ├─ lib/                 # Database, AI, memory, auth, i18n core logic
│  └─ types/               # TypeScript type definitions
├─ public/
│  ├─ avatars/             # Character avatars
│  ├─ generated/           # Generated images
│  └─ attachments/         # Conversation attachments
├─ data/                   # SQLite database directory
├─ assets/                 # README preview images
├─ tests/                  # Node tests (.cjs)
├─ Dockerfile
├─ docker-compose.yml
├─ Start.bat               # Windows local quick-start
├─ README.md
└─ README.en.md
```

---

## Development

`Start.bat` is a Windows local-development shortcut, not a production service manager.

Before committing or deploying, run the same full validation sequence used by CI:

```bash
npm run lint
npm test
npm run regression
npm run build
```

The Next.js-scoped PostCSS override in `package.json` is intentional security hardening. It replaces only Next's transitive copy until upstream ships an equal or newer fix. After upgrading Next, inspect the tree with `npm explain postcss` and verify cleanup with `npm prune --dry-run`.

---

<div align="center">

<br/>

**LumiMuse** — Let them slowly fill your room.

<br/>

[MIT](LICENSE) © 2026 [in30mn1a](https://github.com/in30mn1a)

</div>
