import { loadConfig } from "./src/config/index.js";
import { createProvider } from "./src/providers/factory.js";
import { AgentRunner } from "./src/agent/runner.js";
import { ToolRegistry } from "./src/agent/tools/registry.js";
import { WebSearchTool } from "./src/agent/tools/web.js";
import { buildMessages } from "./src/agent/context.js";

async function main() {
  const cfg = loadConfig();
  const provider = createProvider(cfg);
  const tools = new ToolRegistry();
  tools.register(new WebSearchTool({ maxResults: 2 }));
  const runner = new AgentRunner(provider);
  const messages = buildMessages({
    history: [],
    currentMessage: "Сначала поищи 'Rux language' в вебе, потом на основе результата назови одним предложением что это такое.",
    systemPrompt: "You are a helpful assistant. Use web_search first, then give a one-sentence summary in the user's language.",
  });
  const result = await runner.run({
    initialMessages: messages,
    tools,
    model: cfg.agents.defaults.model,
    maxIterations: 4,
    maxToolResultChars: 8000,
  });
  console.log("FINAL CONTENT:", result.finalContent);
  console.log("STOP REASON:", result.stopReason);
  console.log("TOOLS USED:", result.toolsUsed);
  console.log("USAGE:", result.usage);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
