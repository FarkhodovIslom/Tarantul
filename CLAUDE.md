# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

tarantul is a lightweight personal AI assistant framework written in TypeScript on the [Bun](https://bun.sh) runtime. It supports 25+ LLM providers, a tool-execution agent loop, multi-channel chat (Telegram/Slack/Discord), cron scheduling, a skill system, and an OpenAI-compatible HTTP API. It is a port of an earlier Python implementation; the source code frequently references the Python original in comments (`Mirrors tarantul/agent/runner.py`).

## Commands

```bash
bun install                 # install deps
bun test                    # run all tests (coverage on by default via bunfig.toml)
bun test tests/api.test.ts  # run a single test file
bun test -t "name"          # run tests matching a name
bun run typecheck           # tsc --noEmit (strict)
bun run lint                # biome check src tests
bun run format              # biome format --write src tests

bun run start onboard       # create ~/.tarantul/config.yaml + workspace
bun run start agent         # interactive REPL
bun run start agent -m "…"  # one-shot; also accepts piped stdin
bun run start serve         # OpenAI-compatible API server (default :8080) + channels
```

There is no build step for normal use — Bun executes the TypeScript directly. `tsconfig.json` sets `outDir: ./dist` only for `tsc` output; runtime entry is `src/cli/main.ts`.

## Conventions

- **Relative imports use a `.js` extension** even though the files are `.ts` (required by `moduleResolution: bundler` + `verbatimModuleSyntax`). Match this — `import { X } from "./foo.js"`, not `"./foo"`.
- The `@/*` path alias maps to `src/*` (tsconfig `paths`).
- **Strict TypeScript with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.** Indexed access yields `T | undefined`; optional props cannot be assigned `undefined` explicitly. The linter (`biome`) treats unused vars/imports as errors and non-null assertions / `any` as warnings.
- **Bun-native, zero-framework.** Use `Bun.spawn`, `Bun.file`, `Bun.write`, `Bun.serve()`, `Bun.which()` directly. The HTTP API is a raw `Bun.serve()` fetch handler — no Express/Hono.

## Architecture

The agent is a single tool-using loop (`src/agent/runner.ts`, `AgentRunner`) shared by every front end. The CLI (`cmdAgent`), the API server (`src/api/server.ts`), and chat channels all build messages, hand them to a configured `LLMProvider`, and run the same iterate-tools-until-final-answer cycle.

Request flow: front end → `buildMessages()` (`src/agent/context.ts`) assembles system prompt + history + user turn → `AgentRunner.run()` calls the provider, executes any returned tool calls via the `ToolRegistry`, appends results, and loops until the model returns a final answer or `maxToolIterations` is hit.

Key subsystems:

- **`providers/`** — `LLMProvider` abstraction with two backends: `anthropic.ts` (native SDK: streaming, thinking blocks, prompt caching) and `openai_compat.ts` (everything else). `registry.ts` holds 25 `ProviderSpec` entries; `factory.ts` selects the backend per the configured model/provider.
- **`agent/`** — the loop plus its RAM-critical pieces (see below): `message-buffer.ts`, `context.ts`, `hook.ts`, `tools/`, `memory.ts`.
- **`agent/tools/`** — `Tool` base + `ToolRegistry`; built-ins are `shell.ts` (`exec_command`), `filesystem.ts` (read/write/edit/list), `cron.ts`. Tools validate params against JSON Schema with type casting. `ReadFileTool` takes `extraAllowedDirs` to expose the skills dir.
- **`config/`** — Zod schemas (`schema.ts`) + YAML loader (`loader.ts`); runtime paths under `~/.tarantul/` resolved in `paths.ts`.
- **`session/`** — JSONL conversation persistence with in-memory cache; `getHistory()` projects only LLM-safe fields.
- **`bus/`** — `AsyncQueue<T>` + `MessageBus` for async channel I/O.
- **`channels/`** — `BaseChannel` (ACL via `allowFrom`, streaming) with Telegram (grammY), Slack (Bolt Socket Mode), Discord (discord.js) adapters; `manager.ts` runs the outbound dispatch loop with delta coalescing + retry.
- **`cron/`** — single-timer `CronService` using `croner`; supports one-shot (`at`), interval (`every`), and cron expressions with timezone validation.
- **`skills/`** — `SkillsLoader` discovers `SKILL.md` files (YAML frontmatter) from `~/.tarantul/workspace/skills/` (priority) and the builtin `skills/` dir at repo root. Some skills are always-loaded; others load on context match.
- **`command/`** — slash-command router for the CLI/REPL (`/help`, `/stop`, `/new`, `/status`, `/restart`).
- **`api/`** — OpenAI-compatible server: `POST /v1/chat/completions`, `GET /v1/models`, `GET /health`; Bearer auth, per-session mutex, session multiplexing via a `session_id` field.

## Performance-sensitive code

The agent core is deliberately RAM-optimized relative to the Python original; preserve these patterns when editing `src/agent/`:

- `MessageBuffer` windows context with a `windowStart` pointer — **never clone the message list**. `toProviderView()` is the only per-call shallow copy.
- `applyToolResultBudget()` / `enforceContextBudget()` mutate or shift in place.
- `TokenTracker` (`utils/tokens.ts`) keeps O(1) incremental token counts via a parallel array + `WeakMap` per-message cache.
- `LazyImageBlock` defers base64 encoding until send; `SystemPromptCache` rebuilds only when the source mtime changes.

When touching these, prefer conditional-copy (return the same reference when nothing changed) over allocating new arrays/objects.

## Tests

`bun test` runs all suites in `tests/` (one file per subsystem: `agent-core`, `api`, `channels`, `cli`, `config`, `cron-memory`, `providers`, `session-bus`, `skills`, `tools`, `utils`). Coverage is enabled by default and the per-test timeout is 30s (`bunfig.toml`).
