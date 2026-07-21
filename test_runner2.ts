import { loadConfig } from "./src/config/index.js";
import { createProvider } from "./src/providers/factory.js";
import { AgentRunner } from "./src/agent/runner.js";
import { ToolRegistry } from "./src/agent/tools/registry.js";
import { WebSearchTool } from "./src/agent/tools/web.js";
import { buildMessages } from "./src/agent/context.js";

async function main() {
  const cfg = loadConfig();
  const provider = createProvider(cfg);
  
  // Monkey-patch fetch to see the exact payload sent to OpenRouter
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    console.log("FETCH URL:", url);
    const body = JSON.parse(init.body);
    console.dir(body, { depth: null });
    return originalFetch(url, init);
  };
  
  const tools = new ToolRegistry();
  tools.register(new WebSearchTool({ maxResults: 3 }));
  
  const runner = new AgentRunner(provider);
  const messages = buildMessages({
    history: [],
    currentMessage: "Поищи 'Rux language' на вебе",
    systemPrompt: "You are a helpful assistant. Use web_search.",
  });
  
  await runner.run({
    initialMessages: messages,
    tools,
    model: cfg.agents.defaults.model,
    maxIterations: 3,
    maxToolResultChars: 10000,
  });
}
main().catch(console.error);
