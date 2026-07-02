import { delimiter, resolve } from "node:path";
import { platform } from "node:os";
import { Tool } from "./base.js";

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

function containsPathTraversal(cmd: string): boolean {
  return cmd.includes("../") || cmd.includes("..\\");
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

  constructor(opts: {
    timeout?: number;
    workingDir?: string | null;
    denyPatterns?: RegExp[];
    allowPatterns?: RegExp[];
    restrictToWorkspace?: boolean;
    pathAppend?: string;
  } = {}) {
    super();
    this.timeout = opts.timeout ?? 60;
    this.workingDir = opts.workingDir ?? null;
    this.denyPatterns = opts.denyPatterns ?? DENY_PATTERNS;
    this.allowPatterns = opts.allowPatterns ?? [];
    this.restrictToWorkspace = opts.restrictToWorkspace ?? false;
    this.pathAppend = opts.pathAppend ?? "";
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
    if (guardError) return guardError;

    const env = { ...process.env };
    if (this.pathAppend) {
      env["PATH"] = (env["PATH"] ?? "") + delimiter + this.pathAppend;
    }

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

      const cwdResolved = resolve(cwd);
      for (const raw of this.extractAbsolutePaths(command)) {
        try {
          const p = resolve(raw.trim().replace(/^~/, process.env["HOME"] ?? "~"));
          if (!p.startsWith(cwdResolved)) {
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
    const posix = [...(command.match(/(?:^|[\s|>'"'])(\/[^\s"'>;|<]+)/g) ?? [])];
    const home = [...(command.match(/(?:^|[\s|>'"'])(~[^\s"'>;|<]*)/g) ?? [])];
    return [...posix, ...home].map((s) => s.trim());
  }
}
