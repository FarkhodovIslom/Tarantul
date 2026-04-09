import { describe, it, expect } from "bun:test";
import { ConfigSchema, matchProvider, getApiKey } from "../src/config/schema";

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
