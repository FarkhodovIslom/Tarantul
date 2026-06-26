/**
 * Configuration loading utilities.
 * Mirrors tarantul/config/loader.py
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { type Config, ConfigSchema } from "./schema.js";
import { logger } from "../utils/logger.js";

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

export function loadConfig(configPath?: string): Config {
  const path = configPath ?? getConfigPath();

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw) as unknown;
      const migrated = migrateConfig(data as Record<string, unknown>);
      return ConfigSchema.parse(migrated);
    } catch (err) {
      logger.warn({ err, path }, "Failed to load config, using defaults");
    }
  }

  return ConfigSchema.parse({});
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
