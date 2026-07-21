import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigSchema,
  matchProvider,
  getApiKey,
  resolveActiveModel,
  findModelConfig,
} from "../src/config/schema";
import { loadConfig } from "../src/config/loader";
import { SettingsController } from "../src/config/settings";

describe("ConfigSchema", () => {
  it("parses empty config with defaults", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.agents.defaults.model).toBe("anthropic/claude-opus-4-5");
    expect(cfg.agents.defaults.maxTokens).toBe(8192);
    expect(cfg.gateway.port).toBe(18790);
    expect(cfg.api.port).toBe(8900);
  });

  it("accepts snake_case keys", () => {
    const cfg = ConfigSchema.parse({
      agents: { defaults: { max_tokens: 4096, model: "gpt-4o" } },
    });
    expect(cfg.agents.defaults.maxTokens).toBe(4096);
    expect(cfg.agents.defaults.model).toBe("gpt-4o");
  });

  it("accepts camelCase keys", () => {
    const cfg = ConfigSchema.parse({
      agents: { defaults: { maxTokens: 2048 } },
    });
    expect(cfg.agents.defaults.maxTokens).toBe(2048);
  });

  it("parses provider API keys", () => {
    const cfg = ConfigSchema.parse({
      providers: { anthropic: { apiKey: "sk-ant-test" } },
    });
    expect(cfg.providers.anthropic.apiKey).toBe("sk-ant-test");
  });

  it("parses MCP server config", () => {
    const cfg = ConfigSchema.parse({
      tools: {
        mcpServers: {
          my_server: { command: "npx", args: ["-y", "my-mcp"], type: "stdio" },
        },
      },
    });
    expect(cfg.tools.mcpServers["my_server"]?.command).toBe("npx");
    expect(cfg.tools.mcpServers["my_server"]?.type).toBe("stdio");
  });
});

describe("matchProvider", () => {
  it("matches anthropic by model name", () => {
    const cfg = ConfigSchema.parse({
      providers: { anthropic: { apiKey: "sk-ant-123" } },
    });
    const { providerName } = matchProvider(cfg, "anthropic/claude-opus-4");
    expect(providerName).toBe("anthropic");
  });

  it("returns null when no providers configured", () => {
    const cfg = ConfigSchema.parse({});
    const { providerConfig } = matchProvider(cfg, "anthropic/claude-opus-4");
    expect(providerConfig).toBeNull();
  });

  it("matches openai by gpt keyword", () => {
    const cfg = ConfigSchema.parse({
      providers: { openai: { apiKey: "sk-openai-123" } },
    });
    const { providerName } = matchProvider(cfg, "gpt-4o");
    expect(providerName).toBe("openai");
  });

  it("getApiKey returns key for matched provider", () => {
    const cfg = ConfigSchema.parse({
      providers: { anthropic: { apiKey: "sk-ant-abc" } },
    });
    expect(getApiKey(cfg, "claude-sonnet")).toBe("sk-ant-abc");
  });
});

// ---------------------------------------------------------------------------
// Per-provider models
// ---------------------------------------------------------------------------

describe("ModelConfigSchema + provider models", () => {
  it("parses a models array with per-model params; omitted params stay absent", () => {
    const cfg = ConfigSchema.parse({
      providers: {
        anthropic: {
          apiKey: "k",
          models: [
            { id: "claude-opus-4-8", temperature: 0.3, maxTokens: 4096 },
            { id: "claude-sonnet-5" },
          ],
        },
      },
    });
    expect(cfg.providers.anthropic.models.length).toBe(2);
    expect(cfg.providers.anthropic.models[0]!.id).toBe("claude-opus-4-8");
    expect(cfg.providers.anthropic.models[0]!.temperature).toBe(0.3);
    // An omitted param is genuinely absent (so it can inherit the global default).
    expect("temperature" in cfg.providers.anthropic.models[1]!).toBe(false);
  });

  it("defaults models to an empty array", () => {
    const cfg = ConfigSchema.parse({ providers: { openai: { apiKey: "k" } } });
    expect(cfg.providers.openai.models).toEqual([]);
  });

  it("accepts snake_case per-model params", () => {
    const cfg = ConfigSchema.parse({
      providers: {
        openai: {
          apiKey: "k",
          models: [{ id: "gpt-5", max_tokens: 1000, context_window_tokens: 20000 }],
        },
      },
    });
    expect(cfg.providers.openai.models[0]!.maxTokens).toBe(1000);
    expect(cfg.providers.openai.models[0]!.contextWindowTokens).toBe(20000);
  });
});

describe("findModelConfig", () => {
  it("finds a model by id under a provider, else null", () => {
    const cfg = ConfigSchema.parse({
      providers: { anthropic: { apiKey: "k", models: [{ id: "claude-opus-4-8", temperature: 0.5 }] } },
    });
    expect(findModelConfig(cfg, "anthropic", "claude-opus-4-8")?.temperature).toBe(0.5);
    expect(findModelConfig(cfg, "anthropic", "nope")).toBeNull();
    expect(findModelConfig(cfg, "openai", "claude-opus-4-8")).toBeNull();
  });
});

describe("resolveActiveModel", () => {
  it("uses per-model overrides, falling back to global defaults", () => {
    const cfg = ConfigSchema.parse({
      agents: {
        defaults: {
          provider: "anthropic",
          model: "claude-opus-4-8",
          temperature: 0.1,
          maxTokens: 8192,
          contextWindowTokens: 65536,
        },
      },
      providers: {
        anthropic: { apiKey: "k", models: [{ id: "claude-opus-4-8", temperature: 0.9, maxTokens: 4096 }] },
      },
    });
    const r = resolveActiveModel(cfg);
    expect(r.temperature).toBe(0.9); // per-model override
    expect(r.maxTokens).toBe(4096); // per-model override
    expect(r.contextWindowTokens).toBe(65536); // global fallback (omitted per-model)
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("claude-opus-4-8");
  });

  it("honors an explicit null per-model reasoningEffort over a global value", () => {
    const cfg = ConfigSchema.parse({
      agents: { defaults: { provider: "anthropic", model: "m", reasoningEffort: "high" } },
      providers: { anthropic: { apiKey: "k", models: [{ id: "m", reasoningEffort: null }] } },
    });
    expect(resolveActiveModel(cfg).reasoningEffort).toBeNull();
  });

  it("inherits global reasoningEffort when the model omits it", () => {
    const cfg = ConfigSchema.parse({
      agents: { defaults: { provider: "anthropic", model: "m", reasoningEffort: "high" } },
      providers: { anthropic: { apiKey: "k", models: [{ id: "m" }] } },
    });
    expect(resolveActiveModel(cfg).reasoningEffort).toBe("high");
  });

  it("resolves the provider from the model string when provider is 'auto' (back-compat)", () => {
    const cfg = ConfigSchema.parse({
      agents: { defaults: { provider: "auto", model: "anthropic/claude-x", temperature: 0.2 } },
      providers: { anthropic: { apiKey: "k", models: [{ id: "claude-x", temperature: 0.7 }] } },
    });
    const r = resolveActiveModel(cfg);
    expect(r.provider).toBe("anthropic");
    expect(r.temperature).toBe(0.7); // matched by bare id after prefix strip
  });

  it("falls back to global defaults when no model entry matches", () => {
    const cfg = ConfigSchema.parse({
      agents: { defaults: { provider: "anthropic", model: "unknown", temperature: 0.15 } },
      providers: { anthropic: { apiKey: "k", models: [] } },
    });
    expect(resolveActiveModel(cfg).temperature).toBe(0.15);
  });
});

// ---------------------------------------------------------------------------
// SettingsController — model helpers
// ---------------------------------------------------------------------------

describe("SettingsController — model helpers", () => {
  let tmpDir: string;
  let cfgPath: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tt-cfg-"));
    cfgPath = join(tmpDir, "config.json");
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("configuredProviders lists only providers with >=1 model, with counts", () => {
    const cfg = ConfigSchema.parse({
      providers: {
        anthropic: { apiKey: "k", models: [{ id: "a" }, { id: "b" }] },
        openai: { apiKey: "k", models: [] },
      },
    });
    const sc = new SettingsController(cfg, cfgPath);
    const names = sc.configuredProviders().map((p) => p.name);
    expect(names).toContain("anthropic");
    expect(names).not.toContain("openai");
    expect(sc.configuredProviders().find((p) => p.name === "anthropic")!.modelCount).toBe(2);
  });

  it("providerModels returns the model ids, or [] for an unknown provider", () => {
    const cfg = ConfigSchema.parse({
      providers: { anthropic: { apiKey: "k", models: [{ id: "a" }, { id: "b" }] } },
    });
    const sc = new SettingsController(cfg, cfgPath);
    expect(sc.providerModels("anthropic")).toEqual(["a", "b"]);
    expect(sc.providerModels("nonexistent-xyz")).toEqual([]);
  });

  it("setActiveModel sets provider+model, persists, and fires onProviderChange", () => {
    const cfg = ConfigSchema.parse({
      agents: { defaults: { provider: "auto", model: "old" } },
      providers: { anthropic: { apiKey: "k", models: [{ id: "claude-x" }] } },
    });
    let fired = 0;
    const sc = new SettingsController(cfg, cfgPath, { onProviderChange: () => fired++ });
    const res = sc.setActiveModel("anthropic", "claude-x");
    expect(res.ok).toBe(true);
    expect(cfg.agents.defaults.provider).toBe("anthropic");
    expect(cfg.agents.defaults.model).toBe("claude-x");
    expect(fired).toBe(1);
    // Persisted to disk.
    expect(loadConfig(cfgPath).agents.defaults.model).toBe("claude-x");
  });

  it("setActiveModel rejects an unknown provider", () => {
    const sc = new SettingsController(ConfigSchema.parse({}), cfgPath);
    expect(sc.setActiveModel("not-a-provider", "x").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config migration — flat model → per-provider models
// ---------------------------------------------------------------------------

describe("migrateModels (via loadConfig)", () => {
  let tmpDir: string;
  let cfgPath: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tt-mig-"));
    cfgPath = join(tmpDir, "config.json");
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("lifts the active model into its provider's models on load (old flat config)", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        agents: { defaults: { model: "anthropic/claude-opus-4-5", provider: "auto" } },
        providers: { anthropic: { apiKey: "sk-ant-x" } },
      }),
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg.providers.anthropic.models.map((m) => m.id)).toEqual(["claude-opus-4-5"]);
    // Non-destructive: agents.defaults is untouched (routing stays "auto").
    expect(cfg.agents.defaults.model).toBe("anthropic/claude-opus-4-5");
    expect(cfg.agents.defaults.provider).toBe("auto");
  });

  it("does not inject when models already exist somewhere", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        agents: { defaults: { model: "anthropic/claude-opus-4-5", provider: "auto" } },
        providers: { anthropic: { apiKey: "k", models: [{ id: "some-other" }] } },
      }),
    );
    expect(loadConfig(cfgPath).providers.anthropic.models.map((m) => m.id)).toEqual(["some-other"]);
  });

  it("does not inject when no provider is usable (no api key)", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        agents: { defaults: { model: "anthropic/claude-opus-4-5", provider: "auto" } },
        providers: {},
      }),
    );
    expect(loadConfig(cfgPath).providers.anthropic.models).toEqual([]);
  });
});
