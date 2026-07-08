<div align="center">

# 🕷️ Tarantul

**A lightweight personal AI agent with a real long-term memory.**

Tarantul is a Bun-native, zero-framework AI assistant that remembers you across sessions — building a searchable, `[[wikilink]]`-connected knowledge graph of facts, people, and projects it maintains on its own.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![CI](https://github.com/FarkhodovIslom/Tarantul/actions/workflows/ci.yml/badge.svg)](https://github.com/FarkhodovIslom/Tarantul/actions/workflows/ci.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

</div>

---

## Table of Contents

- [Why Tarantul](#why-tarantul)
- [Quick Start](#quick-start)
- [Long-term Memory](#long-term-memory)
- [Features](#features)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Docker](#docker)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why Tarantul

Most assistants forget everything the moment a conversation ends. Tarantul is built around memory as a first-class citizen — and stays small and hackable while doing it.

- 🧠 **Real long-term memory** — hybrid keyword + semantic search over a per-session knowledge graph the agent writes and traverses itself.
- 🔌 **25+ LLM providers** — Anthropic (native) and any OpenAI-compatible endpoint, behind one interface.
- 💬 **Multi-channel** — Telegram, Slack, and Discord, plus an interactive CLI, all sharing one agent core.
- 🛠️ **Tool-using agent loop** — shell, files, web, cron, and memory, with JSON-Schema-validated parameters.
- ⚡ **Bun-native & zero-framework** — raw `Bun.serve()`, no Express/Fastify; strict TypeScript; RAM-optimized hot paths.
- 🔁 **OpenAI-compatible API** — drop-in `/v1/chat/completions` with session multiplexing.

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- An API key for at least one LLM provider (Anthropic, OpenAI, OpenRouter, …)

### Install

```bash
git clone https://github.com/FarkhodovIslom/Tarantul.git
cd Tarantul
bun install
```

### Configure

```bash
bun run start onboard
```

This creates `~/.tarantul/config.json` and a workspace at `~/.tarantul/workspace/`. Add a provider key:

```json
{
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." }
  }
}
```

### Run

```bash
# Interactive CLI
bun run start agent

# One-shot from an argument
bun run start agent -m "What is a Large Language Model?"

# Pipe input from stdin
echo "Summarize this README" | bun run start agent

# OpenAI-compatible API server + chat channels
bun run start serve
```

---

## Long-term Memory

The feature that sets Tarantul apart. Everything lives as plain files in the workspace — the model only remembers what gets written to disk — indexed for fast recall.

**What it stores** (per session, isolated on disk):

- `MEMORY.md` — the curated index of durable facts.
- `memory/YYYY-MM-DD.md` — append-only daily logs of running context.
- `notes/<Name>.md` — atomic notes for people, projects, and topics, connected with `[[wikilinks]]`.

**How it recalls:**

- **Hybrid search** — SQLite FTS5 keyword (BM25) **plus** embedding vectors (OpenAI / Gemini / any OpenAI-compatible endpoint). No embedding key? It runs keyword-only — still fully functional, fully offline.
- **Knowledge graph** — `[[wikilinks]]` become a graph with backlinks and stubs; search is **graph-augmented**, pulling in linked notes a query alone would miss.
- **Ranking** — weighted vector + keyword fusion, MMR diversity, and time decay on dated logs (evergreen notes never fade).

**How it maintains itself:**

As the context window fills, Tarantul distills the conversation into atomic, linked notes **before** old turns are dropped, then re-indexes immediately — so nothing important is lost and everything stays searchable.

**Memory tools available to the agent:**

| Tool | Purpose |
|---|---|
| `memory_search` | Hybrid keyword + semantic recall across all memory |
| `memory_get` | Read a memory file (optionally a line range) |
| `memory_links` | Traverse the graph: outgoing links, backlinks, neighbors |
| `memory_write` | Persist a fact to `MEMORY.md`, the daily log, or a linked note |

No external database or service — the index is a per-session SQLite file inside the workspace.

---

## Features

### Multi-Provider LLM Support

25+ providers via two backends:

| Backend | Providers |
|---|---|
| **Anthropic (native)** | Claude family — streaming, thinking blocks, prompt caching |
| **OpenAI-compatible** | OpenAI, Azure, Google Gemini, Groq, DeepSeek, Mistral, OpenRouter, Ollama, LM Studio, and more |

Automatic retry with exponential backoff (standard + persistent modes) and image-stripping fallback on non-transient errors.

### Tool System

Built-in tools with JSON Schema parameter validation and automatic type casting:

```
exec            — Shell execution via Bun.spawn (timeout + safety guards)
read_file       — Read files and images (auto-detects PNG/JPEG/GIF/WebP)
write_file      — Write files with directory auto-creation
edit_file       — Surgical string-replacement edits
list_dir        — Directory listing
web_fetch       — HTTP GET with content extraction
web_search      — Web search via a configurable backend
cron            — Schedule one-shot and recurring tasks
memory_search   — Hybrid keyword + semantic memory recall
memory_get      — Read a memory file / line range
memory_links    — Traverse the memory knowledge graph
memory_write    — Persist durable memory (facts, notes, links)
```

In chat channels a `message` tool is also available for sending to specific chats (with media). MCP servers can be attached to expose additional tools.

### Chat Channels

| Channel | Transport | Highlights |
|---|---|---|
| **Telegram** | grammY (long-polling) | HTML formatting, streaming edits, media, group/topic support |
| **Slack** | Bolt (Socket Mode) | mrkdwn, thread replies, file uploads, reaction lifecycle |
| **Discord** | discord.js | Chunked messages, attachments, mention detection |

All channels support ACL via `allowFrom` lists, streaming deltas, and configurable group policies.

### Skills

Extensible skills discovered from `SKILL.md` files with YAML frontmatter. Built-ins include `memory`, `cron`, `github`, `summarize`, `weather`, `tmux`, and `skill-creator`. Workspace skills (`~/.tarantul/workspace/skills/`) take priority over built-ins, and a skill can declare binary/env requirements that are checked at load time.

### OpenAI-Compatible API

```bash
curl http://localhost:8900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "anthropic/claude-opus-4-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

- `POST /v1/chat/completions` — chat with the full tool-execution loop
- `GET /v1/models` — list available models
- `GET /health` — health check

Session multiplexing is supported via a `session_id` extension field.

### Background Services

- **Cron scheduler** — one-shot (`at`), interval (`every`), and cron-expression scheduling with timezone support.
- **Memory consolidation** — automatic distillation of conversation history into linked notes + `MEMORY.md`, followed by an immediate re-index.

---

## Configuration

Config file: `~/.tarantul/config.json` (all keys accept both `camelCase` and `snake_case`).

```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-opus-4-5",
      "workspace": "~/.tarantul/workspace",
      "temperature": 0.1,
      "maxTokens": 8192
    }
  },
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "openai": { "apiKey": "sk-..." }
  },
  "channels": {
    "telegram": { "enabled": true, "token": "BOT_TOKEN", "allowFrom": ["*"] },
    "slack": { "enabled": false, "botToken": "xoxb-...", "appToken": "xapp-...", "allowFrom": ["U12345"] }
  },
  "tools": {
    "memory": { "enable": true, "provider": "auto", "model": "text-embedding-3-small" },
    "restrictToWorkspace": false
  },
  "api": { "host": "127.0.0.1", "port": 8900, "apiKey": "" }
}
```

> **Tip:** set `tools.memory.provider` to `"auto"` (default) to reuse whichever provider key you already have for embeddings, or `"none"` for keyword-only memory. Enable `tools.restrictToWorkspace` to confine file/shell tools to the workspace.

Runtime config can also be changed live from the CLI with `/settings`.

---

## Architecture

```
src/
  agent/        Agent loop, tools, message buffer, context builder, memory*
  api/          OpenAI-compatible HTTP server (Bun.serve)
  bus/          Async message queue for channel I/O
  channels/     Telegram, Slack, Discord adapters
  cli/          REPL, rendering, argument parsing, /settings menu
  command/      Slash-command router (/help, /stop, /status, /new, /settings)
  config/       Zod schemas, JSON loader, runtime paths
  cron/         Cron scheduler (croner)
  providers/    LLM abstraction (Anthropic native + OpenAI-compat)
  session/      JSONL session persistence
  skills/       Skill discovery and loading
  utils/        Logging, token estimation, runtime helpers
skills/         Built-in skill definitions (SKILL.md + YAML frontmatter)
tests/          409 tests across 13 suites
```

The agent is a single tool-using loop shared by every front end (CLI, API, channels): build messages → call the provider → run any returned tool calls → loop until a final answer.

**Design principles**

- **Bun-native** — `Bun.spawn`, `Bun.file`, `Bun.write`, `Bun.serve()`, `Bun.which()` directly; no Node compatibility shims.
- **Strict TypeScript** — `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` enabled.
- **RAM-optimized** — sliding-window buffer (no array copies), lazy image encoding, mtime-cached system prompt, conditional-copy patterns in hot paths.
- **Zero framework** — a raw `Bun.serve()` fetch handler; no Express/Fastify/Hono.

---

## Docker

```bash
bun run docker:build    # build image
bun run docker:serve    # start API server + channels
bun run docker:cli      # interactive CLI session
bun run docker:stop     # stop
```

Two-stage build (`oven/bun:1` → `oven/bun:1-slim`) with a health check and 1 CPU / 1 GB resource limits.

---

## Development

```bash
bun test                 # run all tests (coverage on by default)
bun test tests/api.test.ts   # single suite
bun run typecheck        # tsc --noEmit (strict)
bun run lint             # biome check
bun run format           # biome format --write
```

**Conventions**

- Relative imports use a `.js` extension even for `.ts` files (`moduleResolution: bundler`).
- The `@/*` path alias maps to `src/*`.
- 409 tests across 13 suites (`agent-core`, `api`, `channels`, `cli`, `config`, `cron-memory`, `memory-search`, `providers`, `session-bus`, `settings`, `skills`, `tools`, `utils`).

---

## Roadmap

- [ ] Single-binary releases (`bun build --compile`) and npm publish (`npx tarantul`)
- [ ] CI (tests + typecheck + lint on every PR) with status badges
- [ ] Demo screencast + `examples/` directory
- [ ] Memory graph export for external visualization
- [ ] More channels and provider presets

Ideas and requests welcome — open an [issue](https://github.com/FarkhodovIslom/Tarantul/issues).

---

## Contributing

Contributions are welcome! To get started:

1. Fork and clone the repo, then `bun install`.
2. Make your change, keeping the conventions above.
3. Ensure `bun test`, `bun run typecheck`, and `bun run lint` pass.
4. Open a pull request describing the change.

For larger features, please open an issue first to discuss the approach.

---

## License

[MIT](LICENSE) © Islom Farkhodov
