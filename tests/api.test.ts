/**
 * Tests for Phase 8: OpenAI-compatible API server.
 *
 * Spins up a real Bun.serve() instance on a random port, exercises all
 * endpoints, then tears down.  Uses a MockAgentRunner that returns
 * configurable responses without hitting any LLM.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiServer } from "../src/api/server.js";
import { SessionManager } from "../src/session/manager.js";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import type { ApiServerOpts } from "../src/api/types.js";
import type { AgentRunner, AgentRunSpec, AgentRunResult } from "../src/agent/runner.js";
import type { LLMProvider } from "../src/providers/base.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A fake AgentRunner that returns a fixed response string. */
function makeMockRunner(responseText: string): AgentRunner {
  const fakeResult: AgentRunResult = {
    finalContent: responseText,
    messages: [],
    toolsUsed: [],
    usage: {},
    stopReason: "stop",
    error: null,
    toolEvents: [],
  };
  return {
    run: async (_spec: AgentRunSpec): Promise<AgentRunResult> => fakeResult,
  } as unknown as AgentRunner;
}

/** AgentRunner that always returns empty content (triggers retry path). */
function makeEmptyRunner(): AgentRunner {
  const fakeResult: AgentRunResult = {
    finalContent: "",
    messages: [],
    toolsUsed: [],
    usage: {},
    stopReason: "stop",
    error: null,
    toolEvents: [],
  };
  return {
    run: async (_spec: AgentRunSpec): Promise<AgentRunResult> => fakeResult,
  } as unknown as AgentRunner;
}

/** AgentRunner that throws on every call. */
function makeErrorRunner(): AgentRunner {
  return {
    run: async (_spec: AgentRunSpec): Promise<AgentRunResult> => {
      throw new Error("LLM failed");
    },
  } as unknown as AgentRunner;
}

function makeRunSpec(): Omit<AgentRunSpec, "initialMessages"> {
  return {
    tools: new ToolRegistry(),
    model: "nanobot",
    maxIterations: 10,
    maxToolResultChars: 4000,
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
let server: ApiServer;
let baseUrl: string;

const DEFAULT_OPTS: ApiServerOpts = {
  host: "127.0.0.1",
  port: 0, // OS assigns a free port
  timeoutSecs: 10,
  modelName: "nanobot",
};

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nanobot-api-test-"));
});

afterAll(() => {
  server?.stop();
  rmSync(tmpDir, { recursive: true, force: true });
});

function startServer(
  runner: AgentRunner,
  opts: Partial<ApiServerOpts> = {},
): ApiServer {
  const sessions = new SessionManager(tmpDir);
  const s = new ApiServer(
    { ...DEFAULT_OPTS, ...opts },
    runner,
    sessions,
    new ToolRegistry(),
    makeRunSpec(),
  );
  s.start();
  return s;
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("returns {status: 'ok'} with 200", async () => {
    server = startServer(makeMockRunner("hello"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, string>;
    expect(body["status"]).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

describe("GET /v1/models", () => {
  it("returns a list with the configured model", async () => {
    server = startServer(makeMockRunner("hi"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(200);
    const body = await res.json() as { object: string; data: { id: string }[] };
    expect(body.object).toBe("list");
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.id).toBe("nanobot");
  });
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions — happy path
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions", () => {
  it("returns a chat completion with assistant content", async () => {
    server = startServer(makeMockRunner("The sky is blue."));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nanobot",
        messages: [{ role: "user", content: "Why is the sky blue?" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      object: string;
      model: string;
      choices: { message: { role: string; content: string } }[];
    };
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("nanobot");
    expect(body.choices[0]?.message.role).toBe("assistant");
    expect(body.choices[0]?.message.content).toBe("The sky is blue.");
  });

  it("generates a unique id per response", async () => {
    server = startServer(makeMockRunner("hello"));
    baseUrl = server.url;

    const makeReq = () =>
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }).then((r) => r.json() as Promise<{ id: string }>);

    const [a, b] = await Promise.all([makeReq(), makeReq()]);
    expect(typeof a.id).toBe("string");
    expect(typeof b.id).toBe("string");
    expect(a.id).not.toBe(b.id);
  });

  it("accepts messages array with multiple turns (uses last user turn)", async () => {
    server = startServer(makeMockRunner("Respond!"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "First message" },
          { role: "assistant", content: "OK" },
          { role: "user", content: "Second message" },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });

  it("accepts content as array of content parts (extracts text)", async () => {
    server = startServer(makeMockRunner("text extracted"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: [{ type: "text", text: "hello from parts" }] },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });

  it("routes to custom session_id", async () => {
    server = startServer(makeMockRunner("custom session"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "myuser123",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — validation errors", () => {
  it("returns 400 for invalid JSON", async () => {
    server = startServer(makeMockRunner("ok"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(400);
  });

  it("returns 400 for empty messages array", async () => {
    server = startServer(makeMockRunner("ok"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing user message", async () => {
    server = startServer(makeMockRunner("ok"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "assistant", content: "I spoke first" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for stream=true", async () => {
    server = startServer(makeMockRunner("ok"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for wrong model name", async () => {
    server = startServer(makeMockRunner("ok"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-99",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty user content", async () => {
    server = startServer(makeMockRunner("ok"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "   " }] }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("API key authentication", () => {
  it("returns 401 when API key is required but missing", async () => {
    server = startServer(makeMockRunner("ok"), { apiKey: "secret" });
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong API key", async () => {
    server = startServer(makeMockRunner("ok"), { apiKey: "secret" });
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer wrong",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts correct API key", async () => {
    server = startServer(makeMockRunner("ok"), { apiKey: "secret" });
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer secret",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
  });

  it("allows requests when no API key is configured", async () => {
    server = startServer(makeMockRunner("ok"), { apiKey: null });
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Error / fallback paths
// ---------------------------------------------------------------------------

describe("Error and fallback paths", () => {
  it("returns 500 when runner throws", async () => {
    server = startServer(makeErrorRunner());
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe("server_error");
  });

  it("returns fallback message when runner returns empty content twice", async () => {
    server = startServer(makeEmptyRunner());
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { choices: { message: { content: string } }[] };
    // Should have used EMPTY_FINAL_RESPONSE_MESSAGE fallback
    expect(body.choices[0]!.message.content).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Not found
// ---------------------------------------------------------------------------

describe("Unknown routes", () => {
  it("returns 404 for unknown path", async () => {
    server = startServer(makeMockRunner("ok"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  it("returns 204 for OPTIONS pre-flight", async () => {
    server = startServer(makeMockRunner("ok"));
    baseUrl = server.url;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
