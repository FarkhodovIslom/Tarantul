import type { AskPermission, PermissionRequest } from "../agent/tools/base.js";

// ---------------------------------------------------------------------------
// Pending permission request
// ---------------------------------------------------------------------------

export interface PendingPermission {
  /** Unique identifier for this permission request. */
  id: string;
  /** The original permission request from the tool guard. */
  request: PermissionRequest;
  /** Session key the request originated from. */
  sessionKey: string;
  /** When this request was created. */
  createdAt: string;
  /** Resolves the tool's AskPermission promise. */
  resolve: (allowed: boolean) => void;
}

// ---------------------------------------------------------------------------
// PermissionRegistry — tracks pending per-tool permission prompts for the API
// ---------------------------------------------------------------------------

/**
 * When the server runs with workspace-restricted tools, a tool guard may
 * block an action (e.g. a shell command outside the workspace). In the CLI
 * this triggers an interactive prompt. For the API server, the blocked
 * action is parked here as a "pending permission" that the client can
 * query and resolve via REST endpoints:
 *
 *   GET  /v1/permissions/pending           → list pending requests
 *   POST /v1/permissions/:id/resolve       → { "allow": true|false }
 *
 * Each pending entry holds the resolve() callback that unblocks the tool
 * execution in the runner. A timeout auto-denies if the client never responds.
 */
export class PermissionRegistry {
  private readonly _pending = new Map<string, PendingPermission>();
  private _seq = 0;
  private readonly _timeoutMs: number;

  constructor(timeoutMs: number = 120_000) {
    this._timeoutMs = timeoutMs;
  }

  /**
   * Build an `AskPermission` callback wired to this registry. Pass this to
   * tool constructors so guard-blocked actions become pending permissions
   * instead of hard denies.
   */
  buildAskPermission(sessionKey: string): AskPermission {
    return async (req: PermissionRequest): Promise<boolean> => {
      return this._park(req, sessionKey);
    };
  }

  /** List all currently pending permission requests. */
  listPending(): Omit<PendingPermission, "resolve">[] {
    return [...this._pending.values()].map(({ resolve: _, ...rest }) => rest);
  }

  /** Resolve a pending permission by id. Returns false if the id is unknown. */
  resolve(id: string, allow: boolean): boolean {
    const entry = this._pending.get(id);
    if (!entry) return false;
    this._pending.delete(id);
    entry.resolve(allow);
    return true;
  }

  get size(): number {
    return this._pending.size;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _park(req: PermissionRequest, sessionKey: string): Promise<boolean> {
    const id = `perm_${++this._seq}_${Date.now()}`;
    return new Promise<boolean>((resolve) => {
      const entry: PendingPermission = {
        id,
        request: req,
        sessionKey,
        createdAt: new Date().toISOString(),
        resolve,
      };
      this._pending.set(id, entry);

      // Auto-deny after timeout so tool execution doesn't hang forever.
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          resolve(false);
        }
      }, this._timeoutMs);
    });
  }
}
