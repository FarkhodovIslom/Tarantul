/**
 * CLI multi-session helpers: session-id minting, the active-session pointer
 * file, fallback titles, and relative-time formatting. Deliberately Ink-free
 * and side-effect-light so the pure pieces are unit-testable.
 *
 * Chat history is per-session (one `sessions/<key>.jsonl` per chat), but
 * long-term memory is SHARED across every CLI chat under a single fixed key
 * (`CLI_MEMORY_KEY`) so summaries written on leaving one chat are recalled in
 * the next — see the memory-binding notes in `main.ts`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Session } from "../session/manager.js";

/** Fixed long-term-memory key shared by every CLI chat (preserves memory/cli_direct/). */
export const CLI_MEMORY_KEY = "cli:direct";

/** Legacy single-session key, still resumed on first launch after upgrade. */
export const LEGACY_CLI_SESSION = "cli:direct";

/** True for the legacy key or any minted `cli:*` chat session. */
export function isCliSessionKey(key: string): boolean {
  return key === LEGACY_CLI_SESSION || key.startsWith("cli:");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Mint a sortable per-chat session id: `cli:YYYYMMDD-HHMMSS` (local time). */
export function newCliSessionId(now: Date = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `cli:${stamp}`;
}

/** Path to the pointer file naming the CLI's active chat session. */
export function activePointerPath(workspace: string): string {
  return join(workspace, "sessions", ".active-cli");
}

/** Read the active-session key from the pointer file, or null if absent/empty. */
export function readActivePointer(workspace: string): string | null {
  const p = activePointerPath(workspace);
  if (!existsSync(p)) return null;
  try {
    const v = readFileSync(p, "utf-8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Best-effort write of the active-session pointer (creates the dir if needed). */
export function writeActivePointer(workspace: string, key: string): void {
  const p = activePointerPath(workspace);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${key}\n`, "utf-8");
  } catch {
    // pointer is a convenience, not a correctness requirement
  }
}

/** Max characters kept from the first user message when deriving a title. */
const FALLBACK_TITLE_MAX = 48;

/** Derive a title from the first user message, or null if there is none. */
export function fallbackTitle(session: Session): string | null {
  const first = session.messages.find(
    (m) =>
      m["role"] === "user" && typeof m["content"] === "string" && (m["content"] as string).trim(),
  );
  if (!first) return null;
  const text = (first["content"] as string).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > FALLBACK_TITLE_MAX ? `${text.slice(0, FALLBACK_TITLE_MAX)}…` : text;
}

/** Human-friendly "time ago" for a session's updatedAt. Empty string if unknown. */
export function relativeTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 14) return `${days}d ago`;
  const d = new Date(then);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A readable stand-in label when a session has no stored title. */
export function untitledLabel(key: string): string {
  if (key === LEGACY_CLI_SESSION) return "(default session)";
  // cli:20260720-081530 → "2026-07-20 08:15"
  const m = /^cli:(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(key);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  return key;
}

/**
 * Decide which CLI session to resume on startup:
 *   1. the pointer file's target, if its session file still exists;
 *   2. else the legacy `cli:direct` session, if that file exists (migration);
 *   3. else a freshly minted id (nothing to resume).
 * `resumed` is true for cases 1-2. The caller writes the pointer afterwards.
 */
export function resolveActiveCliSession(
  workspace: string,
  sessionFileExists: (key: string) => boolean,
  now: Date = new Date(),
): { key: string; resumed: boolean } {
  const pointer = readActivePointer(workspace);
  if (pointer && sessionFileExists(pointer)) return { key: pointer, resumed: true };
  if (sessionFileExists(LEGACY_CLI_SESSION)) return { key: LEGACY_CLI_SESSION, resumed: true };
  return { key: newCliSessionId(now), resumed: false };
}
