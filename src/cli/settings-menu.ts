
/**
 * Interactive `/settings` menu for the REPL. Owns the input loop (via the
 * injected `readLine`) for the duration of the menu — no agent turn runs
 * while it's active, so there's no race with session writes. Every mutation
 * goes through {@link SettingsController}, which persists to disk and
 * mutates the live `Config` in place.
 */

import { styled, ansi } from "./render.js";
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

/** Pass `{ secure: true }` for input that must not be written to CLI history (API keys). */
export type MenuReadLine = (opts?: { secure?: boolean }) => Promise<string | null>;

export interface SettingsMenuOptions {
  readLine: MenuReadLine;
  controller: SettingsController;
  skillsLoader: SkillsLoader;
  getSession: () => Session;
}

const BACK_COMMANDS = new Set(["0", "q", "back", "exit"]);
const REASONING_CHOICES = ["low", "medium", "high", "none"] as const;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSettingsMenu(opts: SettingsMenuOptions): Promise<void> {
  const { readLine, controller } = opts;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    printTopMenu(controller);
    const raw = await readLine();
    if (raw === null) return; // EOF (Ctrl-D)
    const choice = raw.trim();
    if (choice === "") continue;
    if (BACK_COMMANDS.has(choice.toLowerCase())) return;

    switch (choice) {
      case "1":
        await modelMenu(opts);
        break;
      case "2":
        await providerMenu(opts);
        break;
      case "3":
        await generationMenu(opts);
        break;
      case "4":
        skillsMenu(opts);
        break;
      case "5":
        usageView(opts);
        break;
      case "6":
        await advancedMenu(opts);
        break;
      default:
        console.log(styled("Unknown option.", ansi.yellow));
    }
  }
}

// ---------------------------------------------------------------------------
// Top menu
// ---------------------------------------------------------------------------

function printTopMenu(controller: SettingsController): void {
  const o = controller.overview();
  console.log();
  console.log(styled("Settings", ansi.bold, ansi.cyan));
  console.log(` ${styled("1)", ansi.cyan)} Model                (${o.model})`);
  console.log(
    ` ${styled("2)", ansi.cyan)} Provider / API keys  (${o.resolvedProvider ?? "none"} · key ${o.keyMasked})`,
  );
  console.log(
    ` ${styled("3)", ansi.cyan)} Generation           (temp ${o.temperature} · max ${o.maxTokens} · ctx ${o.contextWindowTokens})`,
  );
  console.log(` ${styled("4)", ansi.cyan)} Skills`);
  console.log(` ${styled("5)", ansi.cyan)} Usage`);
  console.log(` ${styled("6)", ansi.cyan)} Advanced (raw get/set)`);
  console.log(` ${styled("0)", ansi.cyan)} Back to chat`);
}

function printResult(result: SettingsResult, successMsg: string): void {
  if (result.ok) {
    console.log(styled(`✓ ${successMsg}`, ansi.green));
  } else {
    console.log(styled(`✗ ${result.error}`, ansi.red));
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

async function modelMenu(opts: SettingsMenuOptions): Promise<void> {
  const { readLine, controller } = opts;
  console.log();
  console.log(styled("Model", ansi.bold));
  console.log(`Current: ${controller.overview().model}`);
  console.log(styled("Enter a new model id (blank to cancel):", ansi.dim));

  const input = (await readLine())?.trim();
  if (!input) return;

  const result = controller.setModel(input);
  printResult(result, `Model set to ${input}.`);
}

// ---------------------------------------------------------------------------
// Provider / API keys
// ---------------------------------------------------------------------------

function printProviderList(list: ProviderListEntry[]): void {
  list.forEach((p, i) => {
    const badges = [p.isOauth ? "oauth" : null, p.isLocal ? "local" : null].filter(Boolean);
    const badgeStr = badges.length ? ` [${badges.join(", ")}]` : "";
    const keyStatus = p.hasKey ? styled("key set", ansi.green) : styled("no key", ansi.dim);
    console.log(`  ${String(i + 1).padStart(2)}) ${p.label.padEnd(24)} ${keyStatus}${badgeStr}`);
  });
}

async function providerMenu(opts: SettingsMenuOptions): Promise<void> {
  const { readLine, controller } = opts;
  const list = controller.providerList();
  const o = controller.overview();

  console.log();
  console.log(styled("Provider / API keys", ansi.bold));
  console.log(`Routing: ${o.provider} ${o.provider === "auto" ? `(resolved: ${o.resolvedProvider ?? "none"})` : ""}`);
  printProviderList(list);
  console.log(
    styled(
      "Enter a number to set that provider's API key, or type 'auto' / a provider name to force routing (blank to cancel):",
      ansi.dim,
    ),
  );

  const raw = (await readLine())?.trim();
  if (!raw) return;

  if (/^\d+$/.test(raw)) {
    const idx = Number(raw) - 1;
    const entry = list[idx];
    if (!entry) {
      console.log(styled(`✗ No provider at index ${raw}.`, ansi.red));
      return;
    }
    console.log(styled(`Enter API key for ${entry.label} (input is not saved to CLI history):`, ansi.dim));
    const key = (await readLine({ secure: true }))?.trim();
    if (!key) return;
    printResult(controller.setApiKey(entry.name, key), `API key set for ${entry.label}.`);
    return;
  }

  printResult(controller.setProvider(raw), `Provider routing set to ${raw}.`);
}

// ---------------------------------------------------------------------------
// Generation params
// ---------------------------------------------------------------------------

async function generationMenu(opts: SettingsMenuOptions): Promise<void> {
  const { readLine, controller } = opts;
  const o = controller.overview();

  console.log();
  console.log(styled("Generation", ansi.bold));
  console.log(` 1) Temperature         (${o.temperature})`);
  console.log(` 2) Max tokens          (${o.maxTokens})`);
  console.log(` 3) Context window      (${o.contextWindowTokens})`);
  console.log(` 4) Max tool iterations (${o.maxToolIterations})`);
  console.log(` 5) Reasoning effort    (${o.reasoningEffort ?? "none"})`);
  console.log(` 0) Back`);

  const choice = (await readLine())?.trim();
  if (!choice || BACK_COMMANDS.has(choice.toLowerCase())) return;

  switch (choice) {
    case "1": {
      const n = await promptNumber(readLine, "Enter temperature (0-2):");
      if (n !== null) printResult(controller.setTemperature(n), `Temperature set to ${n}.`);
      break;
    }
    case "2": {
      const n = await promptNumber(readLine, "Enter max tokens:");
      if (n !== null) printResult(controller.setMaxTokens(n), `Max tokens set to ${n}.`);
      break;
    }
    case "3": {
      const n = await promptNumber(readLine, "Enter context window tokens:");
      if (n !== null) printResult(controller.setContextWindow(n), `Context window set to ${n}.`);
      break;
    }
    case "4": {
      const n = await promptNumber(readLine, "Enter max tool iterations:");
      if (n !== null) printResult(controller.setMaxToolIterations(n), `Max tool iterations set to ${n}.`);
      break;
    }
    case "5": {
      console.log(styled(`Enter reasoning effort (${REASONING_CHOICES.join("/")}):`, ansi.dim));
      const raw = (await readLine())?.trim().toLowerCase();
      if (!raw) return;
      const v = raw === "none" ? null : (raw as "low" | "medium" | "high");
      printResult(controller.setReasoningEffort(v), `Reasoning effort set to ${v ?? "none"}.`);
      break;
    }
    default:
      console.log(styled("Unknown option.", ansi.yellow));
  }
}

async function promptNumber(readLine: MenuReadLine, prompt: string): Promise<number | null> {
  console.log(styled(prompt, ansi.dim));
  const raw = (await readLine())?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    console.log(styled(`✗ Not a number: ${raw}`, ansi.red));
    return null;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Skills (read-only)
// ---------------------------------------------------------------------------

function skillsMenu(opts: SettingsMenuOptions): void {
  const { skillsLoader } = opts;
  const all = skillsLoader.listSkills(false);
  const available = new Set(skillsLoader.listSkills(true).map((s) => s.name));
  const always = new Set(skillsLoader.getAlwaysSkills());

  console.log();
  console.log(styled("Skills", ansi.bold));
  if (all.length === 0) {
    console.log(styled("  (none found)", ansi.dim));
    return;
  }
  for (const s of all) {
    const flags = [
      available.has(s.name) ? null : "unavailable",
      always.has(s.name) ? "always" : null,
    ].filter(Boolean);
    const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
    console.log(`  ${s.name.padEnd(24)} ${s.source}${flagStr}`);
  }
}

// ---------------------------------------------------------------------------
// Usage (read-only)
// ---------------------------------------------------------------------------

function usageView(opts: SettingsMenuOptions): void {
  console.log();
  console.log(styled("Usage", ansi.bold));
  console.log(formatUsageSummary(getSessionUsage(opts.getSession())));
}

// ---------------------------------------------------------------------------
// Advanced: raw dotted get/set
// ---------------------------------------------------------------------------

async function advancedMenu(opts: SettingsMenuOptions): Promise<void> {
  const { readLine, controller } = opts;

  console.log();
  console.log(styled("Advanced", ansi.bold));
  console.log(styled("Enter a dotted config path (e.g. agents.defaults.temperature), blank to cancel:", ansi.dim));
  const path = (await readLine())?.trim();
  if (!path) return;

  const current = controller.getValue(path);
  console.log(`Current value: ${JSON.stringify(current)}`);
  console.log(styled("Enter new value, blank to cancel:", ansi.dim));
  const value = (await readLine())?.trim();
  if (!value) return;

  printResult(controller.setValue(path, value), `${path} = ${value}`);
}
