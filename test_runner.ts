import { loadConfig } from "./src/config/index.js";
import { createProvider } from "./src/providers/factory.js";
import { AgentRunner } from "./src/agent/runner.js";
import { ToolRegistry } from "./src/agent/tools/registry.js";
import { WebSearchTool } from "./src/agent/tools/web.js";
import { buildMessages } from "./src/agent/context.js";

async function main() {
  const cfg = loadConfig();
  const provider = createProvider(cfg);
  
  // Monkey patch sanitizeMessages to delete content if null
  const origSanitize = (provider as any).sanitizeMessages.bind(provider);
  (provider as any).sanitizeMessages = function(msgs: any) {
    const res = origSanitize(msgs);
    for (const m of res) {
      if (m.role === "assistant" && m.content === null) {
        delete m.content;
      }
    }
    return res;
  };
  
  const tools = new ToolRegistry();
  tools.register(new WebSearchTool({ maxResults: 3 }));
  
  const runner = new AgentRunner(provider);
  const messages = buildMessages({
    history: [],
    currentMessage: "Поищи 'Rux language' на вебе",
    systemPrompt: "You are a helpful assistant. Use web_search.",
  });
  
  const result = await runner.run({
    initialMessages: messages,
    tools,
    model: cfg.agents.defaults.model,
    maxIterations: 3,
    maxToolResultChars: 10000,
  });
  console.log("FINAL CONTENT:", result.finalContent);
  console.log("STOP REASON:", result.stopReason);
}
main().catch(console.error);
