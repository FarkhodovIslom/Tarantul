/**
 * Phase 1.5: capture the streaming response body from Gemini so we can see
 * exactly where the thought_signature lives in the OpenAI-compat shim output.
 */
import { loadConfig } from "./src/config/index.js";
import { createProvider } from "./src/providers/factory.js";
import { AgentRunner } from "./src/agent/runner.js";
import { ToolRegistry } from "./src/agent/tools/registry.js";
import { WebSearchTool } from "./src/agent/tools/web.js";
import { buildMessages } from "./src/agent/context.js";

async function main() {
  const cfg = loadConfig();

  const realFetch = (await import("node-fetch")).default as unknown as typeof fetch;
  const capturedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.includes("generativelanguage.googleapis.com")) {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (method === "POST" && (headers["accept"]?.includes("text/event-stream") || (init?.body && String(init.body).includes("stream")))) {
        // Don't log request body — log response
      }
    }
    return realFetch(input as never, init as never);
  };

  const provider = createProvider(cfg) as unknown as { client: { fetch: typeof fetch } };
  provider.client.fetch = capturedFetch;

  const tools = new ToolRegistry();
  tools.register(new WebSearchTool({ maxResults: 1 }));

  const runner = new AgentRunner(provider as never);
  const messages = buildMessages({
    history: [],
    currentMessage: "Поищи 'Rux'",
    systemPrompt: "Use web_search.",
  });

  // Manually do the first call via OpenAI SDK so we see the raw streaming response.
  const apiKey = (cfg.providers as Record<string, { apiKey: string }>).gemini?.apiKey ?? "";
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({
    apiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  });
  const stream = await client.chat.completions.create({
    model: "gemini-3.5-flash-lite",
    messages: [
      { role: "system", content: "Use web_search." },
      { role: "user", content: "Поищи 'Rux'" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ],
    tool_choice: "auto",
    stream: true,
  });
  console.error("=== STREAM CHUNKS ===");
  for await (const chunk of stream) {
    console.error("CHUNK:", JSON.stringify(chunk, null, 2));
  }

  // Also try non-streaming to compare shape
  const resp = await client.chat.completions.create({
    model: "gemini-3.5-flash-lite",
    messages: [
      { role: "system", content: "Use web_search." },
      { role: "user", content: "Поиски 'Rux'" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ],
    tool_choice: "auto",
  });
  console.error("=== NON-STREAM RESPONSE ===");
  console.error(JSON.stringify(resp, null, 2));
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
