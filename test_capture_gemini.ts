/**
 * Phase 1 capture: dump every HTTP request the OpenAI SDK makes against Gemini.
 * Intercepts via the SDK's `fetch` constructor option (the SDK uses node-fetch
 * internally and ignores globalThis.fetch monkey-patches).
 *
 * Logs URL, method, headers, and body to stdout, then forwards to the real
 * fetch. Pairs with the real tarantul gemini provider to reproduce the
 * follow-up 400 (no body).
 */
import { loadConfig } from "./src/config/index.js";
import { createProvider } from "./src/providers/factory.js";
import { AgentRunner } from "./src/agent/runner.js";
import { ToolRegistry } from "./src/agent/tools/registry.js";
import { WebSearchTool } from "./src/agent/tools/web.js";
import { buildMessages } from "./src/agent/context.js";

async function main() {
  const cfg = loadConfig();

  // Provide a real fetch to the OpenAI client (it ignores globalThis.fetch).
  const realFetch = (await import("node-fetch")).default as unknown as typeof fetch;
  const capturedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.includes("generativelanguage.googleapis.com")) {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rawBody = init?.body;
      const bodyStr = typeof rawBody === "string" ? rawBody : rawBody ? String(rawBody) : "";
      let parsed: unknown = bodyStr;
      try { parsed = JSON.parse(bodyStr); } catch {}
      console.error("\n===== GEMINI REQUEST =====");
      console.error(`URL: ${url}`);
      console.error(`METHOD: ${method}`);
      console.error("HEADERS:");
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === "authorization") console.error(`  ${k}: ${String(v).slice(0, 18)}…`);
        else console.error(`  ${k}: ${v}`);
      }
      console.error("BODY:");
      console.error(JSON.stringify(parsed, null, 2));
      console.error("===== END REQUEST =====\n");
    }
    return realFetch(input as never, init as never);
  };

  // Inject the capturing fetch into the provider.
  const provider = createProvider(cfg) as unknown as {
    client: { fetch: typeof fetch };
  };
  provider.client.fetch = capturedFetch;

  const tools = new ToolRegistry();
  tools.register(new WebSearchTool({ maxResults: 3 }));

  const runner = new AgentRunner(provider as never);
  const messages = buildMessages({
    history: [],
    currentMessage: "Поищи 'Rux language' на вебе",
    systemPrompt: "You are a helpful assistant. Use web_search.",
  });

  try {
    const result = await runner.run({
      initialMessages: messages,
      tools,
      model: cfg.agents.defaults.model,
      maxIterations: 3,
      maxToolResultChars: 10000,
    });
    console.error("FINAL CONTENT:", result.finalContent);
    console.error("STOP REASON:", result.stopReason);
  } catch (err) {
    console.error("RUN ERROR:", err);
  }
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
