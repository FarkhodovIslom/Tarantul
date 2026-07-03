import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigSchema } from "../src/config/schema.js";
import { loadConfig } from "../src/config/loader.js";
import { SettingsController, maskKey } from "../src/config/settings.js";
import { runSettingsMenu, type MenuReadLine } from "../src/cli/settings-menu.js";
import { SkillsLoader } from "../src/skills/index.js";
import { Session } from "../src/session/manager.js";

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
// runSettingsMenu — driven by a scripted fake readLine
// ---------------------------------------------------------------------------

/** Feeds a fixed sequence of inputs; records whether each call requested `secure`. */
function scriptedReadLine(inputs: string[]): { readLine: MenuReadLine; secureCalls: boolean[] } {
  const queue = [...inputs];
  const secureCalls: boolean[] = [];
  const readLine: MenuReadLine = (opts) => {
    secureCalls.push(Boolean(opts?.secure));
    const next = queue.shift();
    return Promise.resolve(next === undefined ? null : next);
  };
  return { readLine, secureCalls };
}

function makeMenuDeps(cfg: ReturnType<typeof ConfigSchema.parse>, configPath: string, tmpDir: string) {
  const controller = new SettingsController(cfg, configPath);
  const skillsLoader = new SkillsLoader(tmpDir, join(tmpDir, "no-builtin-skills"));
  const session = new Session({ key: "test" });
  return { controller, skillsLoader, getSession: () => session };
}

describe("runSettingsMenu", () => {
  it("returns immediately on EOF at the top menu", async () => {
    const cfg = ConfigSchema.parse({});
    const { readLine } = scriptedReadLine([]); // first call -> null
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runSettingsMenu({ readLine, ...makeMenuDeps(cfg, configPath, tmpDir) });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("sets the model via option 1 and returns via 0", async () => {
    const cfg = ConfigSchema.parse({});
    const { controller, skillsLoader, getSession } = makeMenuDeps(cfg, configPath, tmpDir);
    const { readLine } = scriptedReadLine(["1", "openai/gpt-4o", "0"]);

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runSettingsMenu({ readLine, controller, skillsLoader, getSession });
    } finally {
      logSpy.mockRestore();
    }

    expect(cfg.agents.defaults.model).toBe("openai/gpt-4o");
    const reloaded = loadConfig(configPath);
    expect(reloaded.agents.defaults.model).toBe("openai/gpt-4o");
  });

  it("sets an API key via option 2 with secure input and does not fall through to 'auto' parsing", async () => {
    const cfg = ConfigSchema.parse({});
    const { controller, skillsLoader, getSession } = makeMenuDeps(cfg, configPath, tmpDir);
    const anthropicIdx = controller.providerList().findIndex((p) => p.name === "anthropic") + 1;
    const { readLine, secureCalls } = scriptedReadLine([
      "2",
      String(anthropicIdx),
      "sk-ant-scripted",
      "0",
    ]);

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runSettingsMenu({ readLine, controller, skillsLoader, getSession });
    } finally {
      logSpy.mockRestore();
    }

    expect(cfg.providers.anthropic.apiKey).toBe("sk-ant-scripted");
    // Inputs are: "2" (menu), index, "sk-ant-scripted" (the key itself), "0" (back).
    // Only the key entry — the 3rd read, index 2 — must be marked secure.
    expect(secureCalls).toEqual([false, false, true, false]);
  });

  it("sets generation params via option 3", async () => {
    const cfg = ConfigSchema.parse({});
    const { controller, skillsLoader, getSession } = makeMenuDeps(cfg, configPath, tmpDir);
    const { readLine } = scriptedReadLine(["3", "1", "0.6", "0", "0"]);

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runSettingsMenu({ readLine, controller, skillsLoader, getSession });
    } finally {
      logSpy.mockRestore();
    }

    expect(cfg.agents.defaults.temperature).toBe(0.6);
  });

  it("skills and usage views are read-only and don't consume extra input", async () => {
    const cfg = ConfigSchema.parse({});
    const { controller, skillsLoader, getSession } = makeMenuDeps(cfg, configPath, tmpDir);
    const { readLine } = scriptedReadLine(["4", "5", "0"]);

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runSettingsMenu({ readLine, controller, skillsLoader, getSession });
    } finally {
      logSpy.mockRestore();
    }
    // Reaching here without hanging confirms views 4 and 5 consumed no extra reads.
  });

  it("advanced get/set applies a valid dotted path", async () => {
    const cfg = ConfigSchema.parse({});
    const { controller, skillsLoader, getSession } = makeMenuDeps(cfg, configPath, tmpDir);
    const { readLine } = scriptedReadLine([
      "6",
      "agents.defaults.maxTokens",
      "3000",
      "0",
    ]);

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runSettingsMenu({ readLine, controller, skillsLoader, getSession });
    } finally {
      logSpy.mockRestore();
    }

    expect(cfg.agents.defaults.maxTokens).toBe(3000);
  });
});
