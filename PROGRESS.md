# nanobot-ts — Progress Log

TypeScript + Bun rewrite of the nanobot Python AI agent framework.

---

## Phase 0 — Infrastructure
**Files:** `package.json`, `tsconfig.json`, `biome.json`, `bunfig.toml`

- Bun runtime, strict TypeScript (exactOptionalPropertyTypes, noUncheckedIndexedAccess)
- ESM modules, Biome for linting/formatting
- Key deps: `@anthropic-ai/sdk`, `openai`, `zod`, `@modelcontextprotocol/sdk`, `pino`, `croner`, `js-tiktoken`, `grammy`

---

## Phase 1 — Config System
**Files:** `src/config/schema.ts`, `src/config/loader.ts`, `src/config/paths.ts`, `src/config/index.ts`

- Zod schemas replacing Python Pydantic — `withAliases()` preprocessor for camelCase↔snake_case
- `loadConfig()`, `saveConfig()`, `setConfigPath()`, `migrateConfig()`
- Runtime path helpers: `getDataDir()`, `getWorkspacePath()`, `getMediaDir()`, etc.

---

## Phase 2 — Providers
**Files:** `src/providers/registry.ts`, `src/providers/base.ts`, `src/providers/anthropic.ts`, `src/providers/openai_compat.ts`, `src/providers/factory.ts`, `src/providers/index.ts`

- 25 `ProviderSpec` entries covering all major LLM providers
- Abstract `LLMProvider` with exponential backoff retry (standard + persistent modes)
- Anthropic native SDK — streaming, thinking blocks, prompt caching
- OpenAI-compatible backend — covers 20+ providers, streaming accumulation
- `sanitizeEmptyContent()`, `sanitizeRequestMessages()`, `stripImageContent()` helpers

---

## Phase 3 — Tool System
**Files:** `src/agent/tools/base.ts`, `src/agent/tools/registry.ts`, `src/agent/tools/shell.ts`, `src/agent/tools/filesystem.ts`, `src/agent/tools/index.ts`

- Abstract `Tool` with JSON Schema param casting/validation
- `ToolRegistry` with `execute()`, `prepareCall()`, `getDefinitions()`
- `ExecTool` — shell execution via `Bun.spawn`, safety guard patterns, timeout
- `ReadFileTool`, `WriteFileTool`, `EditFileTool`, `ListDirTool` — image detection, recursive listing

---

## Phase 4 — Agent Core (RAM-optimized)
**Files:** `src/utils/tokens.ts`, `src/utils/runtime.ts`, `src/agent/message-buffer.ts`, `src/agent/hook.ts`, `src/agent/context.ts`, `src/agent/runner.ts`

### RAM optimizations vs Python
| Python (bad) | TypeScript (fixed) |
|---|---|
| `[dict(m) for m in messages]` on every snip | `windowStart` pointer — no allocation |
| `_apply_tool_result_budget` returns new list | `applyToolResultBudget()` mutates in place |
| `list(initial_messages)` copy at run start | `MessageBuffer.appendAll()` — no copy |
| Token recount on every snip iteration | `TokenTracker` parallel array — O(1) per push |
| Per-call token cache misses | `WeakMap<object, number>` — auto-GC cache |
| Base64 encode images on every message build | `LazyImageBlock` — encode only at send time |
| System prompt rebuilt every request | `SystemPromptCache` — mtime dirty check |
| Hook context holds live history ref | `AgentHookContext` — immutable snapshot |

### Key classes
- **`TokenTracker`** — incremental token accounting, O(1) push/drop
- **`MessageBuffer`** — append-only store with `windowStart` sliding pointer; `toProviderView()` is the ONLY shallow copy per LLM call
- **`AgentHook` / `CompositeHook`** — lifecycle hooks with per-hook error isolation
- **`SystemPromptCache`** — mtime-based dirty check on bootstrap files
- **`AgentRunner`** — main tool-use loop using all of the above; concurrent tool batching; finalization retry without buffer mutation

---

---

## Phase 5 — Session Management + Event Bus
**Files:** `src/utils/helpers.ts`, `src/session/manager.ts`, `src/session/index.ts`, `src/bus/events.ts`, `src/bus/queue.ts`, `src/bus/index.ts`

### Session (`src/session/`)
- `Session` — conversation history with `getHistory()` (projects only LLM-safe fields, skips consolidated), `retainRecentLegalSuffix()`, `clear()`
- `SessionManager` — JSONL-based persistence, in-memory Map cache, `save()` / `getOrCreate()` / `invalidate()` / `listSessions()`
- Storage format: line 0 = metadata record, lines 1+ = messages (streams via `Bun.write`, no full-string concat)
- Legacy path migration (moves old `~/.nanobot/sessions/` files to workspace on first access)

### Event bus (`src/bus/`)
- `InboundMessage` / `OutboundMessage` interfaces + `sessionKey()` helper
- `AsyncQueue<T>` — linked-list style, waiters stored as Promise resolve callbacks (no pre-allocation)
- `MessageBus` — inbound + outbound queues; `publishInbound`, `consumeInbound`, `tryConsumeInbound`, `drainOutbound`

### Helpers (`src/utils/helpers.ts`)
- `safeFilename()`, `truncateText()`, `findLegalMessageStart()`

---

---

## Phase 6 — Background Services
**Files:** `src/cron/types.ts`, `src/cron/service.ts`, `src/cron/index.ts`, `src/agent/tools/cron.ts`, `src/agent/memory.ts`

### Cron scheduler (`src/cron/`)
- `CronSchedule` — three kinds: `at` (one-shot), `every` (interval), `cron` (cron expression via `croner`)
- `computeNextRun()` — uses `croner` for cron expressions; `Intl` for timezone validation (no extra deps)
- `CronService` — single-timer architecture: arms one `setTimeout` to the nearest job; mtime-based store reload for external edits; JSONL-adjacent JSON persistence
- `deleteAfterRun` support for one-shot jobs; run history capped at 20 records (in-place splice)

### CronTool (`src/agent/tools/cron.ts`)
- LLM tool: `add` / `list` / `remove` actions
- Blocks nested scheduling inside cron callbacks (`setCronContext`)
- Human-readable `formatTiming()` (e.g. `every 30m`, `cron: 0 9 * * * (UTC)`)

### Memory consolidation (`src/agent/memory.ts`)
- `MemoryStore` — `MEMORY.md` (long-term facts) + `HISTORY.md` (append-only log)
- `consolidate()` — calls LLM with forced `save_memory` tool; falls back to `auto` toolChoice if unsupported; after 3 consecutive failures raw-archives messages
- `MemoryConsolidator` — per-session WeakRef lock chain, iterative consolidation until prompt fits budget

---

---

## Phase 7 — CLI
**Files:** `src/command/router.ts`, `src/command/builtin.ts`, `src/command/index.ts`, `src/cli/render.ts`, `src/cli/repl.ts`, `src/cli/main.ts`

### Command routing (`src/command/`)
- `CommandRouter` — four-tier dispatch: priority (pre-lock) → exact → longest-prefix-first → interceptors
- `AgentLoopRef` minimal interface — decouples commands from full AgentLoop (no circular imports)
- Built-in handlers: `/stop` (cancels active tasks), `/restart` (deferred process restart), `/new` (clears session), `/status` (model + uptime + token stats), `/help`

### CLI rendering (`src/cli/render.ts`)
- Pure ANSI escape codes — no `rich` dep; `styled()`, `ansi` color map, `isColorSupported()` (respects `NO_COLOR`/`FORCE_COLOR`)
- `markdownToAnsi()` — lightweight Markdown→ANSI: headings (bold+cyan), bullets, `**bold**`, `` `code` ``, `*italic*`
- `Spinner` — 80ms interval with `clearLine()` on stop; `pause()` for nested output
- `StreamRenderer` — accumulates streaming deltas, manages spinner lifecycle, `onDelta`/`onEnd`/`close`

### REPL (`src/cli/repl.ts`)
- `CliHistory` — file-based history, max 500 entries, consecutive-duplicate dedup, `appendFileSync`
- `Repl` — `node:readline` wrapper; seeds readline history from file at startup; `readLine()` → `Promise<string | null>`
- `readStdin()` — reads all stdin at once for piped input

### Entry point (`src/cli/main.ts`)
- `parseArgs()` — minimal argv parser (no deps): `--flag value`, `--bool`, `-f value`, `-b`
- Subcommands: `agent` (interactive/one-shot/piped), `onboard` (create/refresh config + workspace), `serve` (stub), `version`
- `cmdAgent()`: creates provider via `createProvider()`, `SessionManager`, `ToolRegistry` with default tools, `AgentRunner`; streams to terminal when stdout is TTY; slash commands dispatched via `CommandRouter`

---

## Tests
| Suite | Tests |
|---|---|
| `tests/config.test.ts` | 9 |
| `tests/tools.test.ts` | 12 |
| `tests/agent-core.test.ts` | 19 |
| `tests/session-bus.test.ts` | 30 |
| `tests/cron-memory.test.ts` | 30 |
| `tests/cli.test.ts` | 33 |
| `tests/api.test.ts` | 21 |
| **Total** | **154 / 154 pass** |

_(Updated in Phase 9 — see current totals below)_

---

## Phase 8 — API Server
**Files:** `src/api/types.ts`, `src/api/server.ts`, `src/api/index.ts`

### OpenAI-compatible HTTP server (`src/api/`)
- `ApiServer` — wraps `Bun.serve()` with typed fetch handler; no external HTTP framework
- Endpoints: `POST /v1/chat/completions`, `GET /v1/models`, `GET /health`, `OPTIONS` (CORS pre-flight)
- Per-session serialisation via `Mutex` (Promise-chain pattern) — prevents interleaved reads/writes to the same session in async context
- Request flow: parse → auth → validate → acquire mutex → run agent → persist → release
- Empty-response retry: if `AgentRunner` returns blank text, retries once; falls back to `EMPTY_FINAL_RESPONSE_MESSAGE`
- Timeout: `Promise.race`-style `withTimeout()` — returns 504 on expiry
- Bearer-token auth: optional `apiKey` in `ApiServerOpts`; skipped when null
- Multi-turn history: accepts OpenAI-style messages array; extracts last user turn for processing
- Session multiplexing: `session_id` extension field routes to named JSONL sessions
- `cmdServe()` in `src/cli/main.ts` wires config + tools + runner + `startApiServer()`

---

## Remaining phases
---

## Phase 9 — Chat Channels
**Files:** `src/channels/base.ts`, `src/channels/telegram.ts`, `src/channels/slack.ts`, `src/channels/discord.ts`, `src/channels/manager.ts`, `src/channels/registry.ts`, `src/channels/index.ts`

### BaseChannel (`src/channels/base.ts`)
- Abstract class with `start()` / `stop()` / `send()` / `sendDelta()` interface
- `isAllowed(senderId)` — allowFrom ACL (`"*"` = open, empty = deny-all, specific IDs)
- `_handleMessage()` — ACL check → adds `_wants_stream` when streaming enabled → `bus.publishInbound()`
- `supportsStreaming` — config flag AND `sendDelta` must be overridden
- `config` is `readonly` (public) so `ChannelManager` can read it

### TelegramChannel (`src/channels/telegram.ts`)
- grammY long-polling; `start()` blocks until `stop()` called
- `send()` — HTML mode (`mdToHtml()` Markdown→Telegram HTML), chunked at 4000 chars, media attachments
- `sendDelta()` — progressive `editMessageText` at 600ms cadence, keyed by `_stream_id`
- Typing indicator loop (every 4s); emoji reactions on inbound messages
- Group policy: `"mention"` (default) or `"open"`; topic-scoped session keys for forum threads
- allow-list extends base with `userId|username` dual matching

### SlackChannel (`src/channels/slack.ts`)
- `@slack/bolt` Socket Mode; no webhook / public IP needed
- `send()` — mrkdwn conversion (inline `mdToMrkdwn()`), optional thread reply, file upload via `files.uploadV2`
- Reaction lifecycle: `:eyes:` on receipt → `:white_check_mark:` on send
- DM policy: `"open"` or `"allowlist"`; group policy: `"mention"` / `"open"` / `"allowlist"`
- Thread-scoped session keys for channel messages
- Deduplication: ignores `app_mention` if plain `message` already captured the mention

### DiscordChannel (`src/channels/discord.ts`)
- `discord.js`; intent bitmask from config (default 37377)
- `send()` — chunked at 2000 chars, file attachments
- Group policy: `"mention"` (bot @-tagged or reply to bot) or `"open"`
- Read-receipt emoji reactions (best effort)

### ChannelManager (`src/channels/manager.ts`)
- `ChannelManager.create(config, bus)` — async factory; lazy-loads channel modules, reads `channels.<name>.enabled` from config
- Outbound dispatch loop: polls bus, filters progress messages per `sendProgress`/`sendToolHints` config
- Delta coalescing: synchronously drains `tryConsumeOutbound()` to merge consecutive `_stream_delta` messages for same `(channel, chatId)`
- Send retry with exponential backoff: delays `[1s, 2s, 4s]`, `sendMaxRetries` attempts
- `startAll()` / `stopAll()` coordinate all channels concurrently
- `cmdServe()` in `src/cli/main.ts` now wires `ChannelManager` alongside the API server

---

## Tests
| Suite | Tests |
|---|---|
| `tests/config.test.ts` | 9 |
| `tests/tools.test.ts` | 12 |
| `tests/agent-core.test.ts` | 19 |
| `tests/session-bus.test.ts` | 30 |
| `tests/cron-memory.test.ts` | 30 |
| `tests/cli.test.ts` | 33 |
| `tests/api.test.ts` | 21 |
| `tests/channels.test.ts` | 22 |
| **Total** | **176 / 176 pass** |

---

## Phase 10 — Skills System
**Files:** `src/skills/loader.ts`, `src/skills/index.ts`, `skills/` (data dir), `tests/skills.test.ts`
**Modified:** `src/agent/tools/filesystem.ts`, `src/api/types.ts`, `src/api/server.ts`, `src/cli/main.ts`

### SkillsLoader (`src/skills/loader.ts`)
- `listSkills(filterUnavailable)` — discovers workspace + builtin skills; workspace takes priority
- `loadSkill(name)` — reads SKILL.md by name (workspace first, then builtin)
- `loadSkillsForContext(names)` — strips frontmatter, formats for context injection
- `buildSkillsSummary()` — XML summary of all skills (available + unavailable); includes `<requires>` for missing deps
- `getAlwaysSkills()` — returns skills with `always: true` in nanobot metadata that meet requirements
- `getSkillMetadata(name)` — parses YAML frontmatter into flat key→value map
- Requirement checking: `Bun.which()` for bins, `process.env` for env vars

### Builtin skills (`skills/`)
- `memory`, `cron`, `github`, `summarize`, `weather`, `tmux`, `clawhub`, `skill-creator`
- `memory` and `cron` are always-loaded (`always: true` in metadata)

### Integration
- `ReadFileTool` now accepts `extraAllowedDirs?: string[]` for skills directory access when workspace is restricted
- `ApiServerOpts.getSystemPrompt?: () => string` — called before each turn to build prompt with memory + skills
- Both `cmdAgent()` and `cmdServe()` instantiate `SkillsLoader`, `MemoryStore`, `SystemPromptCache`; pass live `getSystemPrompt` function so memory + skills changes are reflected per-turn

### System prompt pipeline
```
SystemPromptCache.get(memory, skillsSummary, alwaysContent)
  ├── MemoryStore.getMemoryContext()       → ## Long-term Memory
  ├── SkillsLoader.buildSkillsSummary()   → <skills> XML
  └── SkillsLoader.loadSkillsForContext(getAlwaysSkills()) → # Active Skills
```
Cache invalidates only when file mtimes, memory content, or skills summary change — no rebuild per turn.

---

## Tests
| Suite | Tests |
|---|---|
| `tests/config.test.ts` | 9 |
| `tests/tools.test.ts` | 12 |
| `tests/agent-core.test.ts` | 19 |
| `tests/session-bus.test.ts` | 30 |
| `tests/cron-memory.test.ts` | 30 |
| `tests/cli.test.ts` | 33 |
| `tests/api.test.ts` | 21 |
| `tests/channels.test.ts` | 22 |
| `tests/skills.test.ts` | 29 |
| **Total** | **205 / 205 pass** |

---

## Phase 11 — Tests Expansion
**New files:** `tests/utils.test.ts`, `tests/providers.test.ts`
**Expanded:** `tests/agent-core.test.ts`, `tests/tools.test.ts`

### New test suites
- **`tests/utils.test.ts`** (41 tests) — `runtime.ts`: `ensureNonemptyToolResult`, `isBlankText`, `buildFinalizationRetryMessage`, `repeatedExternalLookupError` (web_fetch/web_search throttling), `buildAssistantMessage`; `tokens.ts`: `estimateMessageTokens` with arrays and tool_calls
- **`tests/providers.test.ts`** (29 tests) — `sanitizeEmptyContent` (empty strings, array blocks, `_meta` removal, object wrapping), `sanitizeRequestMessages` (key filtering, null content injection), `stripImageContent` (replacement, path placeholder, null when no images)

### Expanded suites
- **`tests/agent-core.test.ts`** — Added `CompositeHook` (fan-out, error isolation, `finalizeContent` chain), `SystemPromptCache` (build, cache hit/miss on memory and skills change, bootstrap file integration, mtime rebuild), `buildMessages` (history refs, channel context, same-role merging), `MessageBuffer.snipToFit` (legal boundary enforcement, windowLength/totalTokens accessors)
- **`tests/tools.test.ts`** — Added `Tool.castParams` (string→int/float/bool coercion), `Tool.validateParams` (enum, min/max, minLength/maxLength, nested required, array item types), `Tool.toSchema`, getter coverage, `ReadFileTool.extraAllowedDirs` path enforcement

### Coverage improvements (function % / line %)
| File | Before | After |
|---|---|---|
| `src/utils/runtime.ts` | 50% / 69% | **100% / 100%** |
| `src/agent/context.ts` | 26% / 43% | **84% / 85%** |
| `src/agent/hook.ts` | 42% / 24% | **88% / 92%** |
| `src/agent/message-buffer.ts` | 67% / 44% | **87% / 91%** |
| `src/agent/tools/base.ts` | 54% / 55% | **92% / 88%** |
| `src/providers/base.ts` | 13% / 16% | **48% / 45%** |

---

## Tests
| Suite | Tests |
|---|---|
| `tests/config.test.ts` | 9 |
| `tests/tools.test.ts` | 37 |
| `tests/agent-core.test.ts` | 67 |
| `tests/session-bus.test.ts` | 30 |
| `tests/cron-memory.test.ts` | 30 |
| `tests/cli.test.ts` | 33 |
| `tests/api.test.ts` | 21 |
| `tests/channels.test.ts` | 22 |
| `tests/skills.test.ts` | 29 |
| `tests/utils.test.ts` | 41 |
| `tests/providers.test.ts` | 29 |
| **Total** | **325 / 325 pass** |

---

## Phase 12 — Docker
**Files:** `Dockerfile`, `docker-compose.yml`, `.dockerignore`
**Modified:** `package.json` (Docker scripts)

### Dockerfile
- Two-stage build: `oven/bun:1` for dependency install → `oven/bun:1-slim` for runtime
- Runtime deps: `curl` (health check), `git` (tools), `ca-certificates`
- Copies `src/`, `skills/`, config files; exposes port 8080
- `HEALTHCHECK` against `/health` endpoint
- `ENTRYPOINT ["bun", "run", "src/cli/main.ts"]`, `CMD ["serve"]`

### docker-compose.yml
- `nanobot-serve` — API server + channels; port 8080; restart unless-stopped; 1 CPU / 1GB limit
- `nanobot-cli` — interactive CLI on-demand via `--profile cli`; TTY + stdin enabled
- Common config: `.env` file, `~/.nanobot` volume mount

### .dockerignore
- Excludes `node_modules`, `.git`, tests, coverage, workspace, logs

### package.json scripts
- `docker:build` — `docker build -t nanobot .`
- `docker:serve` — `docker compose up -d nanobot-serve`
- `docker:stop` — `docker compose down`
- `docker:cli` — `docker compose run --rm nanobot-cli`

---

## RAM Optimization Pass

Targeted audit and fix of unnecessary allocations, copies, and spreads across hot paths.

### Fixes applied

1. **`src/providers/anthropic.ts` — `applyCacheControl()`**: Changed from always-spread (`[...messages]`) to conditional copy — only `.slice()` when a slot is actually patched.
2. **`src/providers/anthropic.ts` — `mergeConsecutive()`**: Changed from always-spread (`{ ...msg }`) to direct reference for non-merged messages.
3. **`src/providers/openai_compat.ts` — `applyCacheControl()`**: Same conditional copy pattern — single `.slice()` only when `markSystem` or `markPenultimate` is true.
4. **`src/session/manager.ts` — `getHistory()`**: Removed pointless `.slice()` (no-args copy) when `maxMessages=0` — now returns the sub-array reference directly.
5. **`src/providers/base.ts` — `sanitizeEmptyContent()`**: Changed from `.map()` (always creates new array) to lazy-copy — only allocates a new array on first modified message, returns original ref when nothing changed.
6. **`src/channels/manager.ts` — `_coalesceDeltas()`**: Replaced `+=` string concatenation with `chunks[]` array + single `.join("")` at end.
7. **`src/agent/context.ts` — `buildUserContent()`**: Fixed bogus `{ type: "lazy_image", path: "" } as never` placeholder — now properly appends `{ type: "text", text }` block for the user's text alongside image blocks.

### Patterns established

- **Conditional copy**: Only `.slice()` arrays when actually modifying a slot; use direct references otherwise.
- **Lazy array allocation**: Return same ref when no elements need modification (e.g., `sanitizeEmptyContent`).
- **Array join over `+=`**: Accumulate string chunks in an array, join once at the end.

All 325 tests passing after optimization pass.

---

## All Phases Complete

| Phase | Description | Status |
|---|---|---|
| 0 | Infrastructure (package.json, tsconfig, biome, bunfig) | Done |
| 1 | Config System (Zod schemas, loader, paths) | Done |
| 2 | Providers (Anthropic, OpenAI-compat, registry) | Done |
| 3 | Tool System (base, registry, shell, filesystem) | Done |
| 4 | Agent Core (TokenTracker, MessageBuffer, Runner) | Done |
| 5 | Session + Event Bus (JSONL, AsyncQueue) | Done |
| 6 | Background Services (Cron, Memory) | Done |
| 7 | CLI (CommandRouter, Render, REPL) | Done |
| 8 | API Server (OpenAI-compatible, Bun.serve) | Done |
| 9 | Chat Channels (Telegram, Slack, Discord) | Done |
| 10 | Skills System (SkillsLoader, builtin skills) | Done |
| 11 | Tests Expansion (325 tests, 11 suites) | Done |
| 12 | Docker (multi-stage build, compose) | Done |
