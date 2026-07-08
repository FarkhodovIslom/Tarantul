/**
 * First-run onboarding wizard, driven by a scripted fake keyboard (the same
 * KeyboardIO harness the settings-menu tests use).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KeyEvent, KeyboardIO } from "../src/cli/keyboard.js";
import { runOnboarding } from "../src/cli/onboarding.js";
import { loadConfig } from "../src/config/loader.js";
import { ConfigSchema } from "../src/config/schema.js";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tarantul-onboard-test-"));
  configPath = join(tmpDir, "config.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scripted keyboard (mirrors tests/settings.test.ts)
// ---------------------------------------------------------------------------

interface ScriptedKey {
  str: string;
  key: KeyEvent;
}

const DOWN: ScriptedKey = { str: "", key: { name: "down" } };
const ENTER: ScriptedKey = { str: "\r", key: { name: "enter" } };
const ESC: ScriptedKey = { str: "", key: { name: "escape" } };

function downTimes(n: number): ScriptedKey[] {
  return Array.from({ length: n }, () => DOWN);
}

function chars(s: string): ScriptedKey[] {
  return [...s].map((c) => ({ str: c, key: { name: c } }));
}

function scriptedKeyboardIO(steps: ScriptedKey[][]): { io: KeyboardIO; writes: string[] } {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  let stepIndex = 0;

  const io: KeyboardIO = {
    input: {
      on: (_event, listener) => {
        const keys = steps[stepIndex++] ?? [];
        queueMicrotask(async () => {
          for (const { str, key } of keys) {
            listener(str, key);
            await Promise.resolve();
          }
        });
        return emitter;
      },
      removeListener: (_event, listener) => {
        emitter.removeListener("keypress", listener);
        return emitter;
      },
    },
    output: {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    },
  };
  return { io, writes };
}

// ---------------------------------------------------------------------------

describe("runOnboarding", () => {
  it("configures provider, API key (masked), and default model", async () => {
    const { io, writes } = scriptedKeyboardIO([
      [ENTER], // provider list -> "Anthropic" (index 0, default highlight)
      chars("sk-ant-secret").concat(ENTER), // secure API key entry
      [ENTER], // model step -> accept the default
    ]);

    const result = await runOnboarding({ configPath, baseConfig: ConfigSchema.parse({}), io });

    expect(result.completed).toBe(true);
    const saved = loadConfig(configPath);
    expect(saved.agents.defaults.provider).toBe("anthropic");
    expect(saved.providers.anthropic.apiKey).toBe("sk-ant-secret");
    expect(saved.agents.defaults.model).toBe("claude-opus-4-5");
    // The key must never be echoed in cleartext.
    expect(writes.some((w) => w.includes("sk-ant-secret"))).toBe(false);
  });

  it("accepts a custom model id over the default", async () => {
    const { io } = scriptedKeyboardIO([
      downTimes(1).concat(ENTER), // provider list -> "OpenAI" (index 1)
      chars("sk-openai").concat(ENTER), // API key
      chars("gpt-4o-mini").concat(ENTER), // custom model
    ]);

    await runOnboarding({ configPath, baseConfig: ConfigSchema.parse({}), io });

    const saved = loadConfig(configPath);
    expect(saved.agents.defaults.provider).toBe("openai");
    expect(saved.agents.defaults.model).toBe("gpt-4o-mini");
  });

  it("skips the API-key step for a local provider (Ollama)", async () => {
    // Ollama is the 8th curated entry (index 7): anthropic, openai, openrouter,
    // gemini, deepseek, groq, mistral, ollama.
    const { io } = scriptedKeyboardIO([
      downTimes(7).concat(ENTER), // provider list -> "Ollama"
      [ENTER], // model step -> accept default (no key step in between)
    ]);

    const result = await runOnboarding({ configPath, baseConfig: ConfigSchema.parse({}), io });

    expect(result.completed).toBe(true);
    const saved = loadConfig(configPath);
    expect(saved.agents.defaults.provider).toBe("ollama");
    expect(saved.agents.defaults.model).toBe("llama3.1");
  });

  it("writes a usable default config even when fully skipped", async () => {
    const { io } = scriptedKeyboardIO([[ESC]]); // Esc at the provider list

    const result = await runOnboarding({ configPath, baseConfig: ConfigSchema.parse({}), io });

    expect(result.completed).toBe(false);
    expect(existsSync(configPath)).toBe(true);
    const saved = loadConfig(configPath);
    // Untouched defaults survive the skip.
    expect(saved.agents.defaults.provider).toBe("auto");
  });

  it("re-prompts on an unknown 'Other…' provider name", async () => {
    const { io } = scriptedKeyboardIO([
      downTimes(8).concat(ENTER), // provider list -> "Other…" (index 8, after 8 curated)
      chars("not-a-provider").concat(ENTER), // unknown -> loops back
      downTimes(8).concat(ENTER), // provider list again -> "Other…"
      chars("groq").concat(ENTER), // valid this time
      chars("k").concat(ENTER), // API key
      [ENTER], // model step (no default for Other -> empty, accepts nothing)
    ]);

    const result = await runOnboarding({ configPath, baseConfig: ConfigSchema.parse({}), io });

    expect(result.completed).toBe(true);
    const saved = loadConfig(configPath);
    expect(saved.agents.defaults.provider).toBe("groq");
  });
});
