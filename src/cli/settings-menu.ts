
/**
 * Interactive `/settings` menu for the REPL: arrow keys to move, Enter to
 * select, Esc to go back/cancel. Owns stdin for its entire run (the caller
 * must `Repl.suspend()` first and `Repl.restore()` after — see
 * `keyboard.ts` for why a live `readline.Interface` can't coexist with raw
 * keypress reads) — no agent turn runs while it's active, so there's no
 * race with session writes. Every mutation goes through
 * {@link SettingsController}, which persists to disk and mutates the live
 * `Config` in place.
 */

import { styled, ansi } from "./render.js";
import {
  beginKeyboardSession,
  endKeyboardSession,
  selectMenu,
  promptText,
  type KeyboardIO,
} from "./keyboard.js";
import {
  type SettingsController,
  type SettingsResult,
  type ProviderListEntry,
} from "../config/settings.js";
import type { SkillsLoader } from "../skills/index.js";
import type { Session } from "../session/manager.js";
import { getSessionUsage, formatUsageSummary } from "../agent/usage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettingsMenuOptions {
  controller: SettingsController;
  skillsLoader: SkillsLoader;
  getSession: () => Session;
  /** Injectable for tests; defaults to process.stdin/stdout. */
  io?: KeyboardIO;
}

const REASONING_CHOICES = ["low", "medium", "high", "none"] as const;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSettingsMenu(opts: SettingsMenuOptions): Promise<void> {
  beginKeyboardSession();
  try {
    await menuLoop(opts);
  } finally {
    endKeyboardSession();
  }
}

async function menuLoop(opts: SettingsMenuOptions): Promise<void> {
  const { controller } = opts;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const o = controller.overview();
    const choice = await selectMenu(
      [
        { label: "Model", hint: o.model },
        { label: "Provider / API keys", hint: `${o.resolvedProvider ?? "none"} · key ${o.keyMasked}` },
        {
          label: "Generation",
          hint: `temp ${o.temperature} · max ${o.maxTokens} · ctx ${o.contextWindowTokens}`,
        },
        { label: "Skills" },
        { label: "Usage" },
        { label: "Advanced (raw get/set)" },
        { label: "Back to chat" },
      ],
      { io: opts.io },
    );

    if (choice === null || choice === 6) return; // Esc, or "Back to chat"

    switch (choice) {
      case 0:
        await modelMenu(opts);
        break;
      case 1:
        await providerMenu(opts);
        break;
      case 2:
        await generationMenu(opts);
        break;
      case 3:
        skillsView(opts);
        break;
      case 4:
        usageView(opts);
        break;
      case 5:
        await advancedMenu(opts);
        break;
    }
  }
}

function printResult(io: KeyboardIO | undefined, result: SettingsResult, successMsg: string): void {
  const out = io?.output ?? process.stdout;
  out.write(
    result.ok
      ? `${styled(`✓ ${successMsg}`, ansi.green)}\n`
      : `${styled(`✗ ${result.error}`, ansi.red)}\n`,
  );
}

function log(io: KeyboardIO | undefined, text: string): void {
  (io?.output ?? process.stdout).write(`${text}\n`);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

async function modelMenu(opts: SettingsMenuOptions): Promise<void> {
  const { controller, io } = opts;
  log(io, `\n${styled("Model", ansi.bold)}`);
  log(io, `Current: ${controller.overview().model}`);
  const input = await promptText("Enter a new model id (Esc to cancel):", { io });
  if (input === null) return;
  const trimmed = input.trim();
  if (!trimmed) return;

  printResult(io, controller.setModel(trimmed), `Model set to ${trimmed}.`);
}

// ---------------------------------------------------------------------------
// Provider / API keys
// ---------------------------------------------------------------------------

function providerOptionLabel(p: ProviderListEntry): { label: string; hint: string } {
  const badges = [p.isOauth ? "oauth" : null, p.isLocal ? "local" : null].filter(Boolean);
  const badgeStr = badges.length ? ` [${badges.join(", ")}]` : "";
  return { label: p.label, hint: `${p.hasKey ? "key set" : "no key"}${badgeStr}` };
}

async function providerMenu(opts: SettingsMenuOptions): Promise<void> {
  const { controller, io } = opts;
  const o = controller.overview();

  log(io, `\n${styled("Provider / API keys", ansi.bold)}`);
  log(io, `Routing: ${o.provider}${o.provider === "auto" ? ` (resolved: ${o.resolvedProvider ?? "none"})` : ""}`);

  const action = await selectMenu(
    [
      { label: "Set an API key" },
      { label: "Set provider routing (auto / provider name)" },
      { label: "Back" },
    ],
    { io },
  );
  if (action === null || action === 2) return;

  if (action === 0) {
    const list = controller.providerList();
    const idx = await selectMenu(list.map(providerOptionLabel), { io });
    if (idx === null) return;
    const entry = list[idx]!;

    log(io, `Enter API key for ${entry.label} (input is masked, not saved to CLI history):`);
    const key = await promptText("(Esc to cancel)", { io, secure: true });
    if (key === null) return;
    const trimmed = key.trim();
    if (!trimmed) return;
    printResult(io, controller.setApiKey(entry.name, trimmed), `API key set for ${entry.label}.`);
    return;
  }

  // action === 1: force routing
  const raw = await promptText("Enter 'auto' or a provider name (Esc to cancel):", { io });
  if (raw === null) return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  printResult(io, controller.setProvider(trimmed), `Provider routing set to ${trimmed}.`);
}

// ---------------------------------------------------------------------------
// Generation params
// ---------------------------------------------------------------------------

async function generationMenu(opts: SettingsMenuOptions): Promise<void> {
  const { controller, io } = opts;
  const o = controller.overview();

  log(io, `\n${styled("Generation", ansi.bold)}`);
  const choice = await selectMenu(
    [
      { label: "Temperature", hint: String(o.temperature) },
      { label: "Max tokens", hint: String(o.maxTokens) },
      { label: "Context window", hint: String(o.contextWindowTokens) },
      { label: "Max tool iterations", hint: String(o.maxToolIterations) },
      { label: "Reasoning effort", hint: o.reasoningEffort ?? "none" },
      { label: "Back" },
    ],
    { io },
  );
  if (choice === null || choice === 5) return;

  switch (choice) {
    case 0: {
      const n = await promptNumber(opts, "Enter temperature (0-2):");
      if (n !== null) printResult(io, controller.setTemperature(n), `Temperature set to ${n}.`);
      break;
    }
    case 1: {
      const n = await promptNumber(opts, "Enter max tokens:");
      if (n !== null) printResult(io, controller.setMaxTokens(n), `Max tokens set to ${n}.`);
      break;
    }
    case 2: {
      const n = await promptNumber(opts, "Enter context window tokens:");
      if (n !== null) printResult(io, controller.setContextWindow(n), `Context window set to ${n}.`);
      break;
    }
    case 3: {
      const n = await promptNumber(opts, "Enter max tool iterations:");
      if (n !== null) printResult(io, controller.setMaxToolIterations(n), `Max tool iterations set to ${n}.`);
      break;
    }
    case 4: {
      const idx = await selectMenu(
        REASONING_CHOICES.map((c) => ({ label: c })),
        { io },
      );
      if (idx === null) return;
      const raw = REASONING_CHOICES[idx]!;
      const v = raw === "none" ? null : raw;
      printResult(io, controller.setReasoningEffort(v), `Reasoning effort set to ${v ?? "none"}.`);
      break;
    }
  }
}

async function promptNumber(opts: SettingsMenuOptions, prompt: string): Promise<number | null> {
  const raw = await promptText(prompt, { io: opts.io });
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (Number.isNaN(n)) {
    log(opts.io, styled(`✗ Not a number: ${trimmed}`, ansi.red));
    return null;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Skills (read-only)
// ---------------------------------------------------------------------------

function skillsView(opts: SettingsMenuOptions): void {
  const { skillsLoader, io } = opts;
  const all = skillsLoader.listSkills(false);
  const available = new Set(skillsLoader.listSkills(true).map((s) => s.name));
  const always = new Set(skillsLoader.getAlwaysSkills());

  log(io, `\n${styled("Skills", ansi.bold)}`);
  if (all.length === 0) {
    log(io, styled("  (none found)", ansi.dim));
    return;
  }
  for (const s of all) {
    const flags = [available.has(s.name) ? null : "unavailable", always.has(s.name) ? "always" : null].filter(
      Boolean,
    );
    const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
    log(io, `  ${s.name.padEnd(24)} ${s.source}${flagStr}`);
  }
}

// ---------------------------------------------------------------------------
// Usage (read-only)
// ---------------------------------------------------------------------------

function usageView(opts: SettingsMenuOptions): void {
  log(opts.io, `\n${styled("Usage", ansi.bold)}`);
  log(opts.io, formatUsageSummary(getSessionUsage(opts.getSession())));
}

// ---------------------------------------------------------------------------
// Advanced: raw dotted get/set
// ---------------------------------------------------------------------------

async function advancedMenu(opts: SettingsMenuOptions): Promise<void> {
  const { controller, io } = opts;

  log(io, `\n${styled("Advanced", ansi.bold)}`);
  const path = await promptText("Enter a dotted config path (e.g. agents.defaults.temperature), Esc to cancel:", {
    io,
  });
  if (path === null) return;
  const trimmedPath = path.trim();
  if (!trimmedPath) return;

  const current = controller.getValue(trimmedPath);
  log(io, `Current value: ${JSON.stringify(current)}`);
  const value = await promptText("Enter new value, Esc to cancel:", { io });
  if (value === null) return;
  const trimmedValue = value.trim();
  if (!trimmedValue) return;

  printResult(io, controller.setValue(trimmedPath, trimmedValue), `${trimmedPath} = ${trimmedValue}`);
}
