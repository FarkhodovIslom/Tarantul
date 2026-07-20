import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// History manager
// ---------------------------------------------------------------------------

const MAX_HISTORY = 500;

export class CliHistory {
  private entries: string[] = [];

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      try {
        this.entries = readFileSync(path, "utf-8")
          .split("\n")
          .filter((l) => l.trim())
          .slice(-MAX_HISTORY);
      } catch {
        this.entries = [];
      }
    }
  }

  push(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Deduplicate consecutive identical entries
    if (this.entries[this.entries.length - 1] === trimmed) return;
    this.entries.push(trimmed);
    if (this.entries.length > MAX_HISTORY) this.entries.shift();
    try {
      appendFileSync(this.path, trimmed + "\n", "utf-8");
    } catch {
      // ignore write errors
    }
  }

  get all(): string[] {
    return this.entries.slice();
  }
}

// ---------------------------------------------------------------------------
// Piped / non-interactive input
// ---------------------------------------------------------------------------

/** Read all lines from stdin at once (for piped input). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}
