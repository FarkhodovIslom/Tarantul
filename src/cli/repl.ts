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
    this.createInterface();
  }

  private createInterface(): void {
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

  /**
   * Relinquish stdin so a raw-keypress consumer (the `/settings` menu) can
   * take exclusive control of it. A live `readline.Interface` decodes
   * keypresses itself even while "paused", so it must be fully closed
   * rather than paused — {@link restore} recreates it afterward.
   */
  suspend(): void {
    this.rl?.close();
    this.rl = null;
  }

  /** Recreate the readline interface after {@link suspend}, e.g. once a raw-keypress consumer is done. */
  restore(): void {
    this.createInterface();
  }

  /** Read one line from the user. Returns null on EOF (Ctrl-D). */
  readLine(): Promise<string | null> {
    if (!process.stdout.isTTY) {
      return this.readLinePlain();
    }

    // Claude-code style input chrome: draw a rounded box + hint line, park
    // the cursor on the input row, and after Enter collapse the whole box
    // into a compact dim `> message` echo.
    const cols = Math.max(20, process.stdout.columns || 80);
    const inner = cols - 2;
    process.stdout.write(
      `${styled(`╭${"─".repeat(inner)}╮`, ansi.gray)}\n` +
        "\n" +
        `${styled(`╰${"─".repeat(inner)}╯`, ansi.gray)}\n` +
        `${styled("  /help for commands · exit to quit", ansi.dim)}\n` +
        "\x1b[3A", // park on the (blank) input row
    );

    return new Promise((resolve) => {
      if (!this.rl) {
        resolve(null);
        return;
      }

      this.rl.question("│ > ", (answer) => {
        const line = answer ?? "";
        // The input occupied ceil((prompt+line)/cols) rows; after Enter the
        // cursor sits on the row below the last of them. Jump back to the
        // top border and erase the box + hint, then print the echo.
        const rows = Math.max(1, Math.ceil((4 + line.length) / cols));
        process.stdout.write(`\x1b[${rows + 1}A\r\x1b[J`);
        process.stdout.write(`${styled(`> ${line}`, ansi.dim)}\n`);
        if (this.history) this.history.push(line);
        resolve(line);
      });

      this.rl.once("close", () => resolve(null));
    });
  }

  /** Plain-prompt fallback for non-TTY output (no cursor control). */
  private readLinePlain(): Promise<string | null> {
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

  /**
   * Ask a one-off question with a custom prompt (e.g. a permission request
   * mid-turn). Unlike {@link readLine}, the answer is not pushed to history.
   * Returns null when no interface is active.
   */
  ask(promptText: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.rl) {
        resolve(null);
        return;
      }
      const rl = this.rl;
      // Removed once answered — unlike a leaked once("close"), repeated asks
      // in one session must not pile up listeners on the shared interface.
      const onClose = (): void => resolve(null);
      rl.once("close", onClose);
      rl.question(promptText, (answer) => {
        rl.removeListener("close", onClose);
        resolve(answer ?? "");
      });
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
