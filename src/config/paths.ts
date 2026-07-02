
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getConfigPath } from "./loader.js";

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function getDataDir(): string {
  return ensureDir(join(getConfigPath(), ".."));
}

export function getRuntimeSubdir(name: string): string {
  return ensureDir(join(getDataDir(), name));
}

export function getMediaDir(channel?: string): string {
  const base = getRuntimeSubdir("media");
  return channel ? ensureDir(join(base, channel)) : base;
}

export function getCronDir(): string {
  return getRuntimeSubdir("cron");
}

export function getLogsDir(): string {
  return getRuntimeSubdir("logs");
}

export function getWorkspacePath(workspace?: string): string {
  const raw = workspace ?? join(homedir(), ".tarantul", "workspace");
  const resolved = raw.startsWith("~/") ? raw.replace("~", homedir()) : raw;
  return ensureDir(resolved);
}

export function isDefaultWorkspace(workspace?: string | null): boolean {
  const current = workspace
    ? (workspace.startsWith("~/") ? workspace.replace("~", homedir()) : workspace)
    : join(homedir(), ".tarantul", "workspace");
  const defaultPath = join(homedir(), ".tarantul", "workspace");
  return current === defaultPath;
}

export function getCliHistoryPath(): string {
  return join(homedir(), ".tarantul", "history", "cli_history");
}

export function getBridgeInstallDir(): string {
  return join(homedir(), ".tarantul", "bridge");
}

export function getLegacySessionsDir(): string {
  return join(homedir(), ".tarantul", "sessions");
}
