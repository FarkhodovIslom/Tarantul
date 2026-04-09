/**
 * Interactive REPL for the CLI agent.
 * Uses node:readline (Bun-compatible) with file-based history.
 */

import { createInterface, type Interface } from "node:readline";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { styled, ansi } from "./render.js";

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
// Readline wrapper
// ---------------------------------------------------------------------------

const EXIT_COMMANDS = new Set(["exit", "quit", "/exit", "/quit", ":q"]);

export class Repl {
  private rl: Interface | null = null;
  private history: CliHistory | null = null;

  constructor(private readonly historyPath: string | null = null) {}

  start(): void {
    this.history = this.historyPath ? new CliHistory(this.historyPath) : null;

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: MAX_HISTORY,
    });

    // Seed readline history from file
    if (this.history) {
      for (const entry of this.history.all.reverse()) {
        (this.rl as unknown as { history: string[] }).history?.push(entry);
      }
    }
  }

  /** Read one line from the user. Returns null on EOF (Ctrl-D). */
  readLine(): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.rl) {
        resolve(null);
        return;
      }

      const prompt = styled("You: ", ansi.bold + ansi.blue);
      this.rl.question(prompt, (answer) => {
        const line = answer ?? "";
        if (this.history) this.history.push(line);
        resolve(line);
      });

      this.rl.once("close", () => resolve(null));
    });
  }

  isExit(input: string): boolean {
    return EXIT_COMMANDS.has(input.toLowerCase().trim());
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
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
