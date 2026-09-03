/**
 * Phase 1.6: confirm that round-tripping thought_signature on the assistant
 * tool_calls is sufficient. Try three placements:
 *   H. signature on assistant tool_calls[i].extra_content.google.thought_signature
 *   I. signature on tool message's extra_content (some SDKs put it on the tool)
 *   J. both placements
 */
import { loadConfig } from "./src/config/index.js";

const _cfg = loadConfig();
const API_KEY = (_cfg.providers as Record<string, { apiKey: string }>).gemini?.apiKey ?? "";
const URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const SIG = "El4KXAERTTIPN6DsrSOBn+HfqSJYIuw12dDNplQ/6U/Q7YwPjyB/MzYquXsfKir7zcaOJhw8y+KEGxi0nNb/cN12zPDWw0qHKMvhMjWQiWjnraa9y77Ak0HNN6+MAG5A";

const baseMessages: unknown[] = [
  { role: "system", content: "Use web_search." },
  { role: "user", content: "Поищи 'Rux'" },
];

const baseTool = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
};

const assistantWithSig = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "call_40146",
      type: "function",
      function: { name: "web_search", arguments: '{"query":"Rux"}' },
      extra_content: { google: { thought_signature: SIG } },
    },
  ],
};

const toolWithSig = {
  role: "tool",
  tool_call_id: "call_40146",
  name: "web_search",
  content: "1. Rux — snippet.",
  extra_content: { google: { thought_signature: SIG } },
};

const toolNoSig = {
  role: "tool",
  tool_call_id: "call_40146",
  name: "web_search",
  content: "1. Rux — snippet.",
};

const variants = [
  {
    label: "H. signature on assistant tool_calls (extra_content)",
    msgs: [...baseMessages, assistantWithSig, toolNoSig],
  },
  {
    label: "I. signature on tool message (extra_content)",
    msgs: [...baseMessages, { ...assistantWithSig, tool_calls: [{ ...assistantWithSig.tool_calls[0] }] }, toolWithSig],
  },
  {
    label: "J. signature on both assistant and tool",
    msgs: [...baseMessages, assistantWithSig, toolWithSig],
  },
  {
    label: "K. signature on assistant only, no name on tool",
    msgs: [...baseMessages, assistantWithSig, { role: "tool", tool_call_id: "call_40146", content: "1. Rux — snippet." }],
  },
];

async function main() {
  for (const v of variants) {
    const body = {
      model: "gemini-3.5-flash-lite",
      messages: v.msgs,
      tools: [baseTool],
      tool_choice: "auto",
      temperature: 0.7,
      max_tokens: 4096,
    };
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`\n--- ${v.label}`);
    console.log(`STATUS: ${res.status}`);
    console.log(`BODY:   ${text.slice(0, 400)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
