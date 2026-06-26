# Tarantul 🕷️

A lightweight personal AI assistant framework built with TypeScript and [Bun](https://bun.sh).

Supports 25+ LLM providers, tool execution, multi-channel chat (Telegram, Slack, Discord), scheduled tasks, extensible skills, and an OpenAI-compatible API server.

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- An API key for at least one LLM provider (Anthropic, OpenAI, etc.)

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

This creates a default config at `~/.tarantul/config.yaml` and a workspace at `~/.tarantul/workspace/`. Add your provider API key:

```yaml
providers:
  anthropic:
    api_key: sk-ant-...
```

### Run

```bash
# Interactive CLI
bun run start agent

# One-shot from argument
bun run start agent -m "What is Large Language Model?"

# Pipe input
echo "Summarize this README" | bun run start agent

# API server (port 8080)
bun run start serve
```

---

## Features

### Multi-Provider LLM Support

25+ providers via two backends:

| Backend | Providers |
|---|---|
| **Anthropic (native)** | Claude 4, Opus, Sonnet, Haiku — streaming, thinking blocks, prompt caching |
| **OpenAI-compatible** | OpenAI, Azure, Google Gemini, Groq, Together, Mistral, Fireworks, DeepSeek, Perplexity, Ollama, LM Studio, and more |

Automatic retry with exponential backoff (standard + persistent modes), image stripping fallback on non-transient errors.

### Tool System

Built-in tools for shell execution, file operations (read, write, edit, list), web fetch, web search, cron scheduling, and memory management. All tools support JSON Schema parameter validation with automatic type casting.

```
exec_command    — Shell execution via Bun.spawn with timeout and safety guards
read_file       — Read files and images (auto-detects PNG/JPEG/GIF/WebP)
write_file      — Write files with directory auto-creation
edit_file       — Surgical string replacement edits
list_directory  — Recursive directory listing
web_fetch       — HTTP GET with content extraction
web_search      — Web search via configurable backend
message         — Send messages to specific chat channels
cron            — Schedule recurring tasks
save_memory     — Persist facts to long-term memory
```

### Chat Channels

| Channel | Transport | Features |
|---|---|---|
| **Telegram** | grammY (long-polling) | HTML formatting, streaming edits, media attachments, group/topic support |
| **Slack** | Bolt (Socket Mode) | mrkdwn formatting, thread replies, file uploads, reaction lifecycle |
| **Discord** | discord.js | Chunked messages, file attachments, mention detection |

All channels support ACL via `allowFrom` lists, streaming deltas, and configurable group policies.

### Skills

Extensible skill system with YAML frontmatter discovery:

```
skills/
  memory/SKILL.md        # Always loaded — long-term memory management
  cron/SKILL.md          # Always loaded — task scheduling guide
  github/SKILL.md        # GitHub workflow assistance
  summarize/SKILL.md     # Conversation summarization
  weather/SKILL.md       # Weather lookups
  tmux/SKILL.md          # Terminal multiplexer operations
  clawhub/SKILL.md       # ClawHub integration
  skill-creator/SKILL.md # Create new skills
```

Skills are auto-discovered from both workspace (`~/.tarantul/workspace/skills/`) and builtin directories. Workspace skills take priority. Skills can declare binary and environment requirements that are checked at load time.

### OpenAI-Compatible API

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Endpoints:
- `POST /v1/chat/completions` — Chat with tool execution loop
- `GET /v1/models` — List available models
- `GET /health` — Health check

Supports session multiplexing via `session_id` extension field.

### Background Services

- **Cron scheduler** — One-shot (`at`), interval (`every`), and cron expression scheduling with timezone support
- **Memory consolidation** — Automatic LLM-powered summarization of conversation history into `MEMORY.md` and `HISTORY.md`

### Session Management

JSONL-based conversation persistence with in-memory caching, legacy path migration, and legal message boundary detection.

---

## Architecture

```
src/
  agent/          Core agent loop, tools, message buffer, hooks, context builder
  api/            OpenAI-compatible HTTP server (Bun.serve)
  bus/            Async message queue for channel I/O
  channels/       Telegram, Slack, Discord channel adapters
  cli/            REPL, rendering, argument parsing
  command/        Slash command router (/help, /stop, /status, /new)
  config/         Zod schemas, YAML loader, runtime paths
  cron/           Cron scheduler with croner expressions
  providers/      LLM provider abstraction (Anthropic native + OpenAI-compat)
  session/        JSONL session persistence
  skills/         Skill discovery and loading
  utils/          Logging, token estimation, runtime helpers
skills/           Builtin skill definitions (SKILL.md + YAML frontmatter)
tests/            325 tests across 11 suites
```

### Key Design Decisions

- **Bun-native** — Uses `Bun.spawn`, `Bun.file`, `Bun.write`, `Bun.serve()`, `Bun.which()` directly; no Node.js compatibility shims
- **Strict TypeScript** — `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` enabled
- **RAM-optimized** — Sliding window pointer (no array copies), lazy image encoding, mtime-cached system prompt, conditional-copy patterns throughout hot paths
- **Zero framework** — No Express, Fastify, or Hono; raw `Bun.serve()` fetch handler

---

## Docker

```bash
# Build
bun run docker:build

# Start API server + channels
bun run docker:serve

# Interactive CLI session
bun run docker:cli

# Stop
bun run docker:stop
```

Two-stage build: `oven/bun:1` (deps) → `oven/bun:1-slim` (runtime). Health check included. Resource limits: 1 CPU / 1GB RAM.

---

## Development

```bash
# Run tests
bun test

# Run tests with coverage
bun test --coverage

# Type check
bun run typecheck

# Lint
bun run lint

# Format
bun run format
```

### Test Coverage

| Suite | Tests |
|---|---|
| `config.test.ts` | 9 |
| `tools.test.ts` | 37 |
| `agent-core.test.ts` | 67 |
| `session-bus.test.ts` | 30 |
| `cron-memory.test.ts` | 30 |
| `cli.test.ts` | 33 |
| `api.test.ts` | 21 |
| `channels.test.ts` | 22 |
| `skills.test.ts` | 29 |
| `utils.test.ts` | 41 |
| `providers.test.ts` | 29 |
| **Total** | **325** |

---

## Configuration

Config file: `~/.tarantul/config.yaml`

```yaml
providers:
  anthropic:
    api_key: sk-ant-...
  openai:
    api_key: sk-...

model: claude-sonnet-4-20250514

channels:
  telegram:
    enabled: true
    token: "BOT_TOKEN"
    allow_from: ["*"]
  slack:
    enabled: true
    bot_token: "xoxb-..."
    app_token: "xapp-..."
    allow_from: ["U12345"]

api:
  port: 8080
  api_key: my-secret-key

workspace: ~/.tarantul/workspace
```

All config keys accept both `camelCase` and `snake_case`.

---

## License

MIT
