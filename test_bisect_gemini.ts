/**
 * Phase 1 bisect: POST the captured 2nd request to Gemini with one field
 * removed at a time, until the 400 clears. Logs URL, status, body each time.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "./src/config/index.js";

const _cfg = loadConfig();
const API_KEY = (_cfg.providers as Record<string, { apiKey: string }>).gemini?.apiKey ?? process.env["GEMINI_API_KEY"] ?? "";

const URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const baseBody = {
  model: "gemini-3.5-flash-lite",
  messages: [
    { role: "system", content: "You are a helpful assistant. Use web_search." },
    { role: "user", content: "Поищи 'Rux language' на вебе" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_6312",
          type: "function",
          function: { name: "web_search", arguments: '{"query":"Rux language"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_6312",
      name: "web_search",
      content: "1. Rux — snippet result for testing only.",
    },
  ],
  temperature: 0.7,
  max_tokens: 4096,
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
};

interface Variant {
  label: string;
  transform: (b: typeof baseBody) => unknown;
}

const variants: Variant[] = [
  {
    label: "A. baseline (content:null + name on tool msg)",
    transform: (b) => b,
  },
  {
    label: "B. omit assistant content (set to '')",
    transform: (b) => {
      const c = JSON.parse(JSON.stringify(b));
      c.messages[2].content = "";
      return c;
    },
  },
  {
    label: "C. omit assistant content (delete key)",
    transform: (b) => {
      const c = JSON.parse(JSON.stringify(b));
      delete c.messages[2].content;
      return c;
    },
  },
  {
    label: "D. drop name from tool message",
    transform: (b) => {
      const c = JSON.parse(JSON.stringify(b));
      delete c.messages[3].name;
      return c;
    },
  },
  {
    label: "E. omit assistant content (delete) + drop name on tool",
    transform: (b) => {
      const c = JSON.parse(JSON.stringify(b));
      delete c.messages[2].content;
      delete c.messages[3].name;
      return c;
    },
  },
  {
    label: "F. set assistant content to '' + drop name on tool",
    transform: (b) => {
      const c = JSON.parse(JSON.stringify(b));
      c.messages[2].content = "";
      delete c.messages[3].name;
      return c;
    },
  },
  {
    label: "G. assistant content '' + tool name kept + id prefixed",
    transform: (b) => {
      const c = JSON.parse(JSON.stringify(b));
      c.messages[2].content = "";
      c.messages[2].tool_calls[0].id = "call__" + c.messages[2].tool_calls[0].id;
      c.messages[3].tool_call_id = c.messages[2].tool_calls[0].id;
      return c;
    },
  },
];

async function main() {
  for (const v of variants) {
    const body = v.transform(baseBody);
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    } as never);
    const text = await res.text();
    console.log(`\n--- ${v.label}`);
    console.log(`STATUS: ${res.status}`);
    console.log(`BODY:   ${text.slice(0, 400)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
