
/**
 * Runtime settings mutation layer behind the `/settings` command. Wraps a
 * live `Config` reference: every setter validates, mutates the object
 * in place (never replaces `cfg` itself, and only replaces the specific
 * leaf touched — sibling objects keep their identity), persists to disk,
 * and optionally notifies the caller that the resolved provider changed
 * so it can rebuild the `LLMProvider` + `AgentRunner`.
 */

import { type Config, ConfigSchema, type ProviderConfig, getProviderName } from "./schema.js";
import { saveConfig } from "./loader.js";
import { PROVIDERS, findByName } from "../providers/registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettingsHooks {
  /** Fired after a change that may have altered which provider/API key is in use. */
  onProviderChange?: () => void;
}

export interface SettingsOverview {
  model: string;
  /** "auto" or a forced provider name (agents.defaults.provider). */
  provider: string;
  /** Provider actually resolved for the current model, or null if none matched. */
  resolvedProvider: string | null;
  keyMasked: string;
  temperature: number;
  maxTokens: number;
  contextWindowTokens: number;
  maxToolIterations: number;
  reasoningEffort: "low" | "medium" | "high" | null;
  workspace: string;
}

export interface ProviderListEntry {
  name: string;
  label: string;
  hasKey: boolean;
  isOauth: boolean;
  isLocal: boolean;
}

export type SettingsResult = { ok: true } | { ok: false; error: string };

const REASONING_EFFORTS = ["low", "medium", "high"] as const;

// ---------------------------------------------------------------------------
// SettingsController
// ---------------------------------------------------------------------------

export class SettingsController {
  constructor(
    private readonly cfg: Config,
    private readonly configPath: string,
    private readonly hooks: SettingsHooks = {},
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  overview(): SettingsOverview {
    const d = this.cfg.agents.defaults;
    const resolvedProvider = getProviderName(this.cfg, d.model);
    const providers = this.cfg.providers as Record<string, ProviderConfig>;
    const key = resolvedProvider ? (providers[resolvedProvider]?.apiKey ?? "") : "";

    return {
      model: d.model,
      provider: d.provider,
      resolvedProvider,
      keyMasked: maskKey(key),
      temperature: d.temperature,
      maxTokens: d.maxTokens,
      contextWindowTokens: d.contextWindowTokens,
      maxToolIterations: d.maxToolIterations,
      reasoningEffort: d.reasoningEffort,
      workspace: d.workspace,
    };
  }

  providerList(): ProviderListEntry[] {
    const providers = this.cfg.providers as Record<string, ProviderConfig>;
    return PROVIDERS.map((spec) => ({
      name: spec.name,
      label: spec.label,
      hasKey: Boolean(providers[spec.name]?.apiKey),
      isOauth: spec.isOauth,
      isLocal: spec.isLocal,
    }));
  }

  /** Read a dotted config path (e.g. "agents.defaults.temperature"). */
  getValue(path: string): unknown {
    const keys = path.split(".").filter(Boolean);
    let cursor: unknown = this.cfg;
    for (const key of keys) {
      if (typeof cursor !== "object" || cursor === null) return undefined;
      cursor = (cursor as Record<string, unknown>)[key];
    }
    return cursor;
  }

  // -------------------------------------------------------------------------
  // Focused setters
  // -------------------------------------------------------------------------

  setModel(model: string): SettingsResult {
    const trimmed = model.trim();
    if (!trimmed) return { ok: false, error: "Model name cannot be empty." };

    const before = getProviderName(this.cfg, this.cfg.agents.defaults.model);
    this.cfg.agents.defaults.model = trimmed;
    const after = getProviderName(this.cfg, trimmed);

    this.persist();
    if (before !== after) this.hooks.onProviderChange?.();
    return { ok: true };
  }

  setProvider(name: string): SettingsResult {
    const trimmed = name.trim();
    if (trimmed !== "auto" && !findByName(trimmed)) {
      return { ok: false, error: `Unknown provider: ${trimmed}` };
    }
    this.cfg.agents.defaults.provider = trimmed;
    this.persist();
    this.hooks.onProviderChange?.();
    return { ok: true };
  }

  setApiKey(providerName: string, key: string): SettingsResult {
    const spec = findByName(providerName);
    if (!spec) return { ok: false, error: `Unknown provider: ${providerName}` };

    const providers = this.cfg.providers as Record<string, ProviderConfig>;
    const entry = providers[spec.name];
    if (!entry) return { ok: false, error: `Unknown provider: ${providerName}` };

    entry.apiKey = key.trim();
    this.persist();
    this.hooks.onProviderChange?.();
    return { ok: true };
  }

  setTemperature(n: number): SettingsResult {
    if (!Number.isFinite(n) || n < 0 || n > 2) {
      return { ok: false, error: "Temperature must be a number between 0 and 2." };
    }
    this.cfg.agents.defaults.temperature = n;
    this.persist();
    return { ok: true };
  }

  setMaxTokens(n: number): SettingsResult {
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: "Max tokens must be a positive integer." };
    }
    this.cfg.agents.defaults.maxTokens = n;
    this.persist();
    return { ok: true };
  }

  setContextWindow(n: number): SettingsResult {
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: "Context window must be a positive integer." };
    }
    this.cfg.agents.defaults.contextWindowTokens = n;
    this.persist();
    return { ok: true };
  }

  setMaxToolIterations(n: number): SettingsResult {
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, error: "Max tool iterations must be a positive integer." };
    }
    this.cfg.agents.defaults.maxToolIterations = n;
    this.persist();
    return { ok: true };
  }

  setReasoningEffort(v: "low" | "medium" | "high" | null): SettingsResult {
    if (v !== null && !(REASONING_EFFORTS as readonly string[]).includes(v)) {
      return {
        ok: false,
        error: `Reasoning effort must be one of: ${REASONING_EFFORTS.join(", ")}, or none.`,
      };
    }
    this.cfg.agents.defaults.reasoningEffort = v;
    this.persist();
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Generic advanced setter
  // -------------------------------------------------------------------------

  /**
   * Set an arbitrary dotted config path from a raw string, coercing to the
   * existing leaf's type and re-validating the whole config against
   * {@link ConfigSchema} before committing. Only the touched leaf is written
   * back onto the live `cfg` — sibling objects keep their identity so
   * closures holding onto e.g. `cfg.agents.defaults` stay in sync.
   */
  setValue(path: string, rawValue: string): SettingsResult {
    const keys = path.split(".").filter(Boolean);
    if (keys.length === 0) return { ok: false, error: "Path cannot be empty." };

    const clone = structuredClone(this.cfg) as unknown as Record<string, unknown>;
    const cloneParent = walkToParent(clone, keys);
    const leafKey = keys[keys.length - 1]!;
    if (!cloneParent || !(leafKey in cloneParent)) {
      return { ok: false, error: `Unknown config path: ${path}` };
    }
    cloneParent[leafKey] = coerceValue(rawValue, cloneParent[leafKey]);

    const parsed = ConfigSchema.safeParse(clone);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
    }

    const liveParent = walkToParent(this.cfg as unknown as Record<string, unknown>, keys)!;
    const validatedParent = walkToParent(parsed.data as unknown as Record<string, unknown>, keys)!;
    liveParent[leafKey] = validatedParent[leafKey];

    this.persist();
    const touchesProvider =
      path.startsWith("providers.") ||
      path === "agents.defaults.model" ||
      path === "agents.defaults.provider";
    if (touchesProvider) this.hooks.onProviderChange?.();
    return { ok: true };
  }

  // -------------------------------------------------------------------------

  private persist(): void {
    saveConfig(this.cfg, this.configPath);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function maskKey(key: string): string {
  if (!key) return "(not set)";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function walkToParent(
  root: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | null {
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = cursor[keys[i]!];
    if (typeof next !== "object" || next === null) return null;
    cursor = next as Record<string, unknown>;
  }
  return cursor;
}

function coerceValue(raw: string, existing: unknown): unknown {
  if (typeof existing === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (typeof existing === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw;
  }
  if (existing === null) {
    if (raw === "" || raw === "null") return null;
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}
