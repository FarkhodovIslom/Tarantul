import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KeyEvent, KeyboardIO } from "../src/cli/keyboard.js";
import { runSettingsMenu } from "../src/cli/settings-menu.js";
import { loadConfig } from "../src/config/loader.js";
import { ConfigSchema } from "../src/config/schema.js";
import { SettingsController, maskKey } from "../src/config/settings.js";
import { Session } from "../src/session/manager.js";
import { SkillsLoader } from "../src/skills/index.js";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tarantul-settings-test-"));
  configPath = join(tmpDir, "config.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("maskKey", () => {
  it("reports unset keys", () => {
    expect(maskKey("")).toBe("(not set)");
  });

  it("masks short keys entirely", () => {
    expect(maskKey("sk-123")).toBe("•".repeat(6));
  });

  it("masks long keys with head/tail", () => {
    expect(maskKey("sk-abcdefghijklmnop")).toBe("sk-a…mnop");
  });
});

describe("SettingsController", () => {
  it("setModel persists to disk and survives reload", () => {
    const cfg = ConfigSchema.parse({});
    const settings = new SettingsController(cfg, configPath);

    const result = settings.setModel("gpt-4o");
    expect(result.ok).toBe(true);
    expect(cfg.agents.defaults.model).toBe("gpt-4o");

    const reloaded = loadConfig(configPath);
    expect(reloaded.agents.defaults.model).toBe("gpt-4o");
  });

  it("setApiKey persists to disk and survives reload", () => {
    const cfg = ConfigSchema.parse({});
    const settings = new SettingsController(cfg, configPath);

    const result = settings.setApiKey("anthropic", "sk-ant-test");
    expect(result.ok).toBe(true);
    expect(cfg.providers.anthropic.apiKey).toBe("sk-ant-test");

    const reloaded = loadConfig(configPath);
    expect(reloaded.providers.anthropic.apiKey).toBe("sk-ant-test");
  });

  it("setApiKey rejects unknown providers", () => {
    const cfg = ConfigSchema.parse({});
    const settings = new SettingsController(cfg, configPath);

    const result = settings.setApiKey("not-a-provider", "sk-test");
    expect(result.ok).toBe(false);
  });

  it("setTemperature persists to disk", () => {
    const cfg = ConfigSchema.parse({});
    const settings = new SettingsController(cfg, configPath);

    const result = settings.setTemperature(0.7);
    expect(result.ok).toBe(true);
    expect(cfg.agents.defaults.temperature).toBe(0.7);

    const reloaded = loadConfig(configPath);
    expect(reloaded.agents.defaults.temperature).toBe(0.7);
  });

  it("setTemperature rejects out-of-range values and leaves cfg unchanged", () => {
    const cfg = ConfigSchema.parse({});
    const settings = new SettingsController(cfg, configPath);

    const before = cfg.agents.defaults.temperature;
    const result = settings.setTemperature(9);
    expect(result.ok).toBe(false);
    expect(cfg.agents.defaults.temperature).toBe(before);
  });

  it("setValue applies a valid dotted path with type coercion", () => {
    const cfg = ConfigSchema.parse({});
    const settings = new SettingsController(cfg, configPath);

    const result = settings.setValue("agents.defaults.maxTokens", "4096");
    expect(result.ok).toBe(true);
    expect(cfg.agents.defaults.maxTokens).toBe(4096);

    const reloaded = loadConfig(configPath);
    expect(reloaded.agents.defaults.maxTokens).toBe(4096);
  });

  it("setValue rejects invalid values and leaves cfg unchanged", () => {
    const cfg = ConfigSchema.parse({});
    const settings = new SettingsController(cfg, configPath);

    const before = cfg.agents.defaults.temperature;
    const result = settings.setValue("agents.defaults.temperature", "9");
    expect(result.ok).toBe(false);
    expect(cfg.agents.defaults.temperature).toBe(before);
  });

  it("setValue rejects unknown paths", () => {
    const cfg = ConfigSchema.parse({});
    const settings = new SettingsController(cfg, configPath);

    const result = settings.setValue("agents.defaults.doesNotExist", "1");
    expect(result.ok).toBe(false);
  });

  it("setValue preserves sibling object identity (in-place mutation)", () => {
    const cfg = ConfigSchema.parse({});
    const defaultsRef = cfg.agents.defaults;
    const settings = new SettingsController(cfg, configPath);

    settings.setValue("agents.defaults.maxTokens", "1234");
    expect(cfg.agents.defaults).toBe(defaultsRef);
    expect(cfg.agents.defaults.maxTokens).toBe(1234);
  });

  it("onProviderChange fires for setApiKey", () => {
    const cfg = ConfigSchema.parse({});
    let fired = 0;
    const settings = new SettingsController(cfg, configPath, {
      onProviderChange: () => fired++,
    });

    settings.setApiKey("anthropic", "sk-ant-test");
    expect(fired).toBe(1);
  });

  it("onProviderChange fires for setProvider", () => {
    const cfg = ConfigSchema.parse({});
    let fired = 0;
    const settings = new SettingsController(cfg, configPath, {
      onProviderChange: () => fired++,
    });

    settings.setProvider("openai");
    expect(fired).toBe(1);
  });

  it("onProviderChange fires when a model change resolves to a different provider", () => {
    const cfg = ConfigSchema.parse({
      providers: {
        anthropic: { apiKey: "sk-ant-test" },
        openai: { apiKey: "sk-openai-test" },
      },
    });
    let fired = 0;
    const settings = new SettingsController(cfg, configPath, {
      onProviderChange: () => fired++,
    });

    // Default model already resolves to anthropic (its key is configured),
    // so switching to another anthropic model is not a provider change.
    settings.setModel("anthropic/claude-opus-4");
    expect(fired).toBe(0);
    settings.setModel("gpt-4o");
    expect(fired).toBe(1);
    settings.setModel("anthropic/claude-opus-4");
    expect(fired).toBe(2);
  });

  it("onProviderChange does not fire for setTemperature/setMaxTokens", () => {
    const cfg = ConfigSchema.parse({});
    let fired = 0;
    const settings = new SettingsController(cfg, configPath, {
      onProviderChange: () => fired++,
    });

    settings.setTemperature(0.5);
    settings.setMaxTokens(2048);
    settings.setContextWindow(32_000);
    settings.setMaxToolIterations(50);
    settings.setReasoningEffort("high");
    expect(fired).toBe(0);
  });

  it("overview reflects live mutations", () => {
    const cfg = ConfigSchema.parse({
      providers: { anthropic: { apiKey: "sk-ant-abcdefgh" } },
    });
    const settings = new SettingsController(cfg, configPath);

    settings.setModel("anthropic/claude-opus-4");
    const overview = settings.overview();
    expect(overview.model).toBe("anthropic/claude-opus-4");
    expect(overview.resolvedProvider).toBe("anthropic");
    expect(overview.keyMasked).not.toBe("(not set)");
  });

  it("providerList reports hasKey per provider", () => {
    const cfg = ConfigSchema.parse({
      providers: { anthropic: { apiKey: "sk-ant-test" } },
    });
    const settings = new SettingsController(cfg, configPath);

    const list = settings.providerList();
    const anthropic = list.find((p) => p.name === "anthropic");
    const openai = list.find((p) => p.name === "openai");
    expect(anthropic?.hasKey).toBe(true);
    expect(openai?.hasKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runSettingsMenu — driven by a scripted fake keyboard (arrow-key UI)
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

/**
 * Fake KeyboardIO for `selectMenu`/`promptText`. Each `.on("keypress", …)`
 * call (i.e. each prompt the menu shows) consumes the next `steps[]` entry
 * and asynchronously replays its keys to that listener — mirrors a user
 * typing a scripted sequence into a sequence of prompts. `writes` captures
 * everything rendered, so tests can assert secrets are masked, not just
 * that the final value was applied.
 */
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

function makeMenuDeps(
  cfg: ReturnType<typeof ConfigSchema.parse>,
  cfgPath: string,
  workDir: string,
) {
  const controller = new SettingsController(cfg, cfgPath);
  const skillsLoader = new SkillsLoader(workDir, join(workDir, "no-builtin-skills"));
  const session = new Session({ key: "test" });
  return { controller, skillsLoader, getSession: () => session };
}

describe("runSettingsMenu", () => {
  it("returns immediately on Esc at the top menu", async () => {
    const cfg = ConfigSchema.parse({});
    const { io } = scriptedKeyboardIO([[ESC]]);
    await runSettingsMenu({ ...makeMenuDeps(cfg, configPath, tmpDir), io });
  });

  it("sets the model via arrow selection + Enter, then Esc back to chat", async () => {
    const cfg = ConfigSchema.parse({});
    const deps = makeMenuDeps(cfg, configPath, tmpDir);
    // top menu: "Model" is index 0 (default highlight) -> Enter picks it.
    const { io } = scriptedKeyboardIO([[ENTER], chars("openai/gpt-4o").concat(ENTER), [ESC]]);

    await runSettingsMenu({ ...deps, io });

    expect(cfg.agents.defaults.model).toBe("openai/gpt-4o");
    const reloaded = loadConfig(configPath);
    expect(reloaded.agents.defaults.model).toBe("openai/gpt-4o");
  });

  it("sets an API key via the provider submenu, masking it on screen", async () => {
    const cfg = ConfigSchema.parse({});
    const deps = makeMenuDeps(cfg, configPath, tmpDir);
    const anthropicIdx = deps.controller.providerList().findIndex((p) => p.name === "anthropic");
    expect(anthropicIdx).toBeGreaterThanOrEqual(0);

    const { io, writes } = scriptedKeyboardIO([
      downTimes(1).concat(ENTER), // top menu -> "Provider / API keys" (index 1)
      [ENTER], // provider submenu -> "Set an API key" (index 0)
      downTimes(anthropicIdx).concat(ENTER), // provider list -> anthropic
      chars("sk-ant-scripted").concat(ENTER), // secure key entry
      [ESC], // back to chat
    ]);

    await runSettingsMenu({ ...deps, io });

    expect(cfg.providers.anthropic.apiKey).toBe("sk-ant-scripted");
    expect(writes.some((w) => w.includes("sk-ant-scripted"))).toBe(false);
    expect(writes.some((w) => w.includes("•"))).toBe(true);
  });

  it("sets generation params via arrow selection", async () => {
    const cfg = ConfigSchema.parse({});
    const deps = makeMenuDeps(cfg, configPath, tmpDir);
    const { io } = scriptedKeyboardIO([
      downTimes(2).concat(ENTER), // top menu -> "Generation" (index 2)
      [ENTER], // generation submenu -> "Temperature" (index 0)
      chars("0.6").concat(ENTER),
      [ESC],
    ]);

    await runSettingsMenu({ ...deps, io });

    expect(cfg.agents.defaults.temperature).toBe(0.6);
  });

  it("skills and usage views are read-only and don't consume extra prompts", async () => {
    const cfg = ConfigSchema.parse({});
    const deps = makeMenuDeps(cfg, configPath, tmpDir);
    const { io } = scriptedKeyboardIO([
      downTimes(6).concat(ENTER), // top menu -> "Skills" (index 6), synchronous, no prompt
      downTimes(7).concat(ENTER), // top menu -> "Usage" (index 7), synchronous, no prompt
      [ESC], // top menu -> back to chat
    ]);

    await runSettingsMenu({ ...deps, io });
    // Reaching here without hanging confirms the read-only views consumed no extra prompts.
  });

  it("advanced get/set applies a valid dotted path", async () => {
    const cfg = ConfigSchema.parse({});
    const deps = makeMenuDeps(cfg, configPath, tmpDir);
    const { io } = scriptedKeyboardIO([
      downTimes(8).concat(ENTER), // top menu -> "Advanced" (index 8)
      chars("agents.defaults.maxTokens").concat(ENTER),
      chars("3000").concat(ENTER),
      [ESC],
    ]);

    await runSettingsMenu({ ...deps, io });

    expect(cfg.agents.defaults.maxTokens).toBe(3000);
  });

  it("toggles a tool boolean via the Tools submenu", async () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.tools.web.enable).toBe(true);
    const deps = makeMenuDeps(cfg, configPath, tmpDir);
    const { io } = scriptedKeyboardIO([
      downTimes(3).concat(ENTER), // top menu -> "Tools" (index 3)
      [ENTER], // Tools submenu -> "Web tools" (index 0) toggles it
      [ESC], // leave Tools submenu
      [ESC], // leave top menu
    ]);

    await runSettingsMenu({ ...deps, io });

    expect(cfg.tools.web.enable).toBe(false);
    const reloaded = loadConfig(configPath);
    expect(reloaded.tools.web.enable).toBe(false);
  });

  it("sets the web search provider via the Tools submenu", async () => {
    const cfg = ConfigSchema.parse({});
    const deps = makeMenuDeps(cfg, configPath, tmpDir);
    const { io } = scriptedKeyboardIO([
      downTimes(3).concat(ENTER), // top menu -> "Tools"
      downTimes(1).concat(ENTER), // Tools -> "Web search provider" (index 1)
      downTimes(2).concat(ENTER), // choice list -> "brave" (index 2)
      [ESC], // leave Tools submenu
      [ESC], // leave top menu
    ]);

    await runSettingsMenu({ ...deps, io });

    expect(cfg.tools.web.search.provider).toBe("brave");
  });

  it("sets the API port via the API server submenu", async () => {
    const cfg = ConfigSchema.parse({});
    const deps = makeMenuDeps(cfg, configPath, tmpDir);
    const { io } = scriptedKeyboardIO([
      downTimes(4).concat(ENTER), // top menu -> "API server" (index 4)
      downTimes(1).concat(ENTER), // API submenu -> "Port" (index 1)
      chars("9100").concat(ENTER),
      [ESC], // leave API submenu
      [ESC], // leave top menu
    ]);

    await runSettingsMenu({ ...deps, io });

    expect(cfg.api.port).toBe(9100);
  });
});
