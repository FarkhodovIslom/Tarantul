# 🌐 Server Mode (API Server) Documentation

Tarantul's Server Mode (`bun run start serve`) exposes a Bun-native, OpenAI-compatible HTTP API server alongside background chat channels (Telegram, Slack, Discord), background cron scheduling, and automatic memory consolidation.

It has **100% feature parity** with the interactive CLI Agent mode, allowing remote clients to execute full tool loops, manage sessions, stream responses via SSE, mutate runtime settings, handle tool permission requests, and monitor session usage.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Authentication](#authentication)
- [Endpoints Overview](#endpoints-overview)
- [Chat Completions](#chat-completions)
  - [Standard Chat (JSON Response)](#standard-chat-json-response)
  - [Streaming Chat (SSE / Event-Stream)](#streaming-chat-sse--event-stream)
  - [Session Multiplexing (`session_id`)](#session-multiplexing-session_id)
- [Session Management](#session-management)
- [Request Cancellation](#request-cancellation)
- [Tool Permission Handling](#tool-permission-handling)
- [Settings & Model Switching](#settings--model-switching)
- [Status, Usage & Discovery](#status-usage--discovery)
- [Architecture & Safety](#architecture--safety)

---

## Quick Start

Start the server using the Tarantul CLI:

```bash
# Start API server on default host (127.0.0.1:8900)
bun run start serve

# Specify custom host, port, workspace, and enable logs
bun run start serve --host 0.0.0.0 --port 9000 --workspace ~/.tarantul/ws --logs
```

### Configuration (`config.json`)

Server configuration defaults live in `~/.tarantul/config.json`:

```json
{
  "api": {
    "host": "127.0.0.1",
    "port": 8900,
    "apiKey": "your-secret-api-key",
    "timeout": 120
  }
}
```

---

## Authentication

If `api.apiKey` is configured in `config.json`, all endpoints (except `/health` and `/v1/models`) require a Bearer token in the `Authorization` header:

```http
Authorization: Bearer your-secret-api-key
```

If `api.apiKey` is empty (default), authentication is disabled.

---

## Endpoints Overview

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | Execute chat turn with full tool loop (supports `stream=true`) |
| `GET` | `/v1/models` | List available model(s) |
| `GET` | `/v1/sessions` | List all persisted chat sessions |
| `POST` | `/v1/sessions` | Create a new chat session |
| `DELETE` | `/v1/sessions/:id` | Delete a session and its memory file |
| `POST` | `/v1/sessions/:id/clear` | Clear message history for a session |
| `POST` | `/v1/cancel` | Cancel an in-flight request for a session |
| `GET` | `/v1/settings` | Overview of current runtime settings |
| `PATCH` | `/v1/settings` | Update a configuration setting dynamically |
| `GET` | `/v1/settings/providers` | List configured providers and models |
| `POST` | `/v1/settings/model` | Switch the active provider and model |
| `GET` | `/v1/permissions/pending` | List tool actions awaiting user approval |
| `POST` | `/v1/permissions/:id/resolve` | Approve or deny a pending tool action |
| `GET` | `/v1/status` | Server version, uptime, and model info |
| `GET` | `/v1/usage` | Default session token usage & cost summary |
| `GET` | `/v1/usage/:session_id` | Session-specific token usage & cost summary |
| `GET` | `/v1/help` | List all available API endpoints |
| `GET` | `/health` | Health check (`{ "status": "ok" }`) |

---

## Chat Completions

### Standard Chat (JSON Response)

```bash
curl http://127.0.0.1:8900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-api-key" \
  -d '{
    "model": "anthropic/claude-opus-4-5",
    "messages": [
      { "role": "user", "content": "What is the weather in Tokyo?" }
    ]
  }'
```

**Response:**

```json
{
  "id": "chatcmpl-a1b2c3d4e5f6",
  "object": "chat.completion",
  "created": 1770000000,
  "model": "anthropic/claude-opus-4-5",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The current weather in Tokyo is 18°C and clear."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 120,
    "completion_tokens": 45,
    "total_tokens": 165
  },
  "tools_used": ["web_search"]
}
```

### Streaming Chat (SSE / Event-Stream)

Pass `"stream": true` to receive real-time deltas and tool execution metadata over Server-Sent Events:

```bash
curl --no-buffer http://127.0.0.1:8900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-api-key" \
  -d '{
    "messages": [{ "role": "user", "content": "Write a python script" }],
    "stream": true
  }'
```

**Stream Output Example:**

```text
event: tool_start
data: {"id":"t1","tool":"write_file","label":"write_file(path)"}

event: tool_end
data: {"id":"t1","tool":"write_file","status":"ok","detail":"wrote 120 bytes"}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1770000000,"model":"...","choices":[{"index":0,"delta":{"role":"assistant","content":"I have "},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1770000000,"model":"...","choices":[{"index":0,"delta":{"content":"created the file."},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1770000000,"model":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### Session Multiplexing (`session_id`)

Specify a `session_id` in the request body to bind the turn to a specific session key (`api:<session_id>`). Each session maintains its own message history and isolated long-term memory store:

```bash
curl http://127.0.0.1:8900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "project-apollo",
    "messages": [{ "role": "user", "content": "Remember that our target deadline is Oct 15." }]
  }'
```

---

## Session Management

### List Sessions

```bash
curl http://127.0.0.1:8900/v1/sessions
```

```json
{
  "sessions": [
    {
      "key": "api:project-apollo",
      "title": "Remember that our target deadline is Oct 15.",
      "created_at": "2026-07-30T10:00:00.000Z",
      "updated_at": "2026-07-30T10:05:00.000Z"
    }
  ]
}
```

### Create Session

```bash
curl -X POST http://127.0.0.1:8900/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{ "session_id": "my-new-chat" }'
```

### Clear Session History

Resets conversation history while retaining long-term memory:

```bash
curl -X POST http://127.0.0.1:8900/v1/sessions/my-new-chat/clear
```

### Delete Session

Permanently removes the session file from disk:

```bash
curl -X DELETE http://127.0.0.1:8900/v1/sessions/my-new-chat
```

---

## Request Cancellation

If a session has an active in-flight request, you can cancel it cleanly using `POST /v1/cancel`:

```bash
curl -X POST http://127.0.0.1:8900/v1/cancel \
  -H "Content-Type: application/json" \
  -d '{ "session_id": "project-apollo" }'
```

*Note: For streaming connections, dropping the HTTP connection automatically triggers an immediate abort on the server.*

---

## Tool Permission Handling

When `tools.restrictToWorkspace` is enabled or a tool guard flags a operation, tool executions park as pending approval items instead of failing immediately.

### List Pending Permissions

```bash
curl http://127.0.0.1:8900/v1/permissions/pending
```

```json
{
  "pending": [
    {
      "id": "perm_1_1770000000",
      "request": {
        "tool": "exec",
        "action": "git push origin main",
        "reason": "Shell command execution requires approval"
      },
      "sessionKey": "api:default",
      "createdAt": "2026-07-30T10:00:00.000Z"
    }
  ]
}
```

### Approve or Deny Permission

```bash
curl -X POST http://127.0.0.1:8900/v1/permissions/perm_1_1770000000/resolve \
  -H "Content-Type: application/json" \
  -d '{ "allow": true }'
```

---

## Settings & Model Switching

### View Overview

```bash
curl http://127.0.0.1:8900/v1/settings
```

### List Configured Providers & Models

```bash
curl http://127.0.0.1:8900/v1/settings/providers
```

### Switch Active Model

Switch the active model across the server at runtime:

```bash
curl -X POST http://127.0.0.1:8900/v1/settings/model \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-20241022",
    "persist": false
  }'
```

---

## Status, Usage & Discovery

### Server Status & Uptime

```bash
curl http://127.0.0.1:8900/v1/status
```

```json
{
  "version": "0.1.4",
  "model": "anthropic/claude-opus-4-5",
  "uptime": "2h 15m",
  "uptime_seconds": 8100
}
```

### Session Usage & Cost Summary

```bash
# Default session usage
curl http://127.0.0.1:8900/v1/usage

# Specific session usage
curl http://127.0.0.1:8900/v1/usage/project-apollo
```

```json
{
  "session_key": "api:project-apollo",
  "usage": {
    "promptTokens": 1540,
    "completionTokens": 320,
    "totalTokens": 1860,
    "cachedTokens": 0,
    "costUsd": 0.0245,
    "costKnown": true,
    "callCount": 4,
    "lastModel": "anthropic/claude-opus-4-5",
    "lastUpdatedAt": "2026-07-30T10:05:00.000Z"
  },
  "formatted": "Session usage (4 calls, last model: anthropic/claude-opus-4-5):\n  Prompt tokens:     1,540\n  Completion tokens: 320\n  Total tokens:      1,860\n  Estimated cost:    $0.0245"
}
```

### API Endpoint Discovery

```bash
curl http://127.0.0.1:8900/v1/help
```

---

## Architecture & Safety

1. **Per-Session Concurrency Lock**: Server Mode uses a `MutexRegistry` to serialize turns for the same `session_id`. Concurrent requests for different sessions run in parallel.
2. **Duplicate Request Auto-Abort**: If a client sends a second request for an already active `session_id`, the server automatically aborts the previous turn's execution controller.
3. **Full Turn Persistence**: Every user message, model call, tool execution request, and tool execution result is recorded into the session's `.jsonl` file.
4. **Background Integration**: Memory consolidation runs seamlessly in the background as context windows fill, auto-distilling conversation logs into linked notes in the workspace.
