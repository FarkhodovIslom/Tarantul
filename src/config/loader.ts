
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { type Config, ConfigSchema } from "./schema.js";

// ---------------------------------------------------------------------------
// Config path management (module-level singleton for multi-instance support)
// ---------------------------------------------------------------------------

let _currentConfigPath: string | null = null;

export function setConfigPath(path: string): void {
  _currentConfigPath = path;
}

export function getConfigPath(): string {
  return _currentConfigPath ?? join(homedir(), ".tarantul", "config.json");
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Load config from disk. A missing file is expected on first run and yields
 * defaults. A file that exists but is malformed (bad JSON) or fails schema
 * validation throws instead of silently falling back to defaults — running
 * with an unnoticed empty config (e.g. no API key) produces confusing
 * downstream errors that are much harder to diagnose than a startup failure.
 */
export function loadConfig(configPath?: string): Config {
  const path = configPath ?? getConfigPath();

  if (!existsSync(path)) {
    return ConfigSchema.parse({});
  }

  const hint = `Fix the file, or remove it and run 'tarantul onboard' to regenerate defaults.`;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read config at ${path}: ${err}. ${hint}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config at ${path} is not valid JSON: ${err}. ${hint}`);
  }

  const migrated = migrateConfig(data as Record<string, unknown>);
  const parsed = ConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new Error(`Config at ${path} failed validation:\n${parsed.error.message}\n${hint}`);
  }
  return parsed.data;
}

export function saveConfig(config: Config, configPath?: string): void {
  const path = configPath ?? getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const data = configToJson(config);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Serialization: Config → plain JSON object (camelCase keys, nulls stripped)
// ---------------------------------------------------------------------------

function configToJson(config: Config): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Migration: old config formats → current
// ---------------------------------------------------------------------------

function migrateConfig(data: Record<string, unknown>): Record<string, unknown> {
  // Move tools.exec.restrictToWorkspace → tools.restrictToWorkspace
  const tools = (data["tools"] ?? {}) as Record<string, unknown>;
  const execCfg = (tools["exec"] ?? {}) as Record<string, unknown>;

  const oldKey = "restrictToWorkspace";
  const oldKeyCamel = "restrictToWorkspace";

  for (const key of [oldKey, oldKeyCamel]) {
    if (key in execCfg && !(key in tools)) {
      tools[key] = execCfg[key];
      delete execCfg[key];
    }
  }

  return data;
}
