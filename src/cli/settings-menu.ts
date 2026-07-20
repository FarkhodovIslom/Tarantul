/**
 * Interactive `/settings` menu for the REPL: arrow keys to move, Enter to
 * select, Esc to go back/cancel. Owns stdin for its entire run (the caller
 * must unmount whatever else is reading stdin first — the Ink app in
 * `main.ts` — and remount it after; see `keyboard.ts` for why a raw keypress
 * reader can't coexist with another stdin consumer) — no agent turn runs
 * while it's active, so there's no race with session writes. Every mutation
 * goes through {@link SettingsController}, which persists to disk and
 * mutates the live `Config` in place.
 */

import { formatUsageSummary, getSessionUsage } from "../agent/usage.js";
import {
  type ProviderListEntry,
  type SettingsController,
  type SettingsResult,
  maskKey,
} from "../config/settings.js";
import type { Session } from "../session/manager.js";
import type { SkillsLoader } from "../skills/index.js";
import {
  type KeyboardIO,
  beginKeyboardSession,
  endKeyboardSession,
  promptText,
  selectMenu,
} from "./keyboard.js";
import { ansi, styled } from "./render.js";

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
const SEARCH_PROVIDERS = ["duckduckgo", "searxng", "brave", "tavily"] as const;
const RETRY_MODES = ["standard", "persistent"] as const;

function onOff(v: unknown): string {
  return v ? "on" : "off";
}

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

  const g = (p: string): unknown => controller.getValue(p);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const o = controller.overview();
    const choice = await selectMenu(
      [
        { label: "Model", hint: o.model },
        {
          label: "Provider / API keys",
          hint: `${o.resolvedProvider ?? "none"} · key ${o.keyMasked}`,
        },
        {
          label: "Generation",
          hint: `temp ${o.temperature} · max ${o.maxTokens} · ctx ${o.contextWindowTokens}`,
        },
        {
          label: "Tools",
          hint: `web ${g("tools.web.enable") ? "on" : "off"} · exec ${g("tools.exec.enable") ? "on" : "off"} · memory ${g("tools.memory.enable") ? "on" : "off"}`,
        },
        { label: "API server", hint: `${g("api.host")}:${g("api.port")}` },
        {
          label: "Agent",
          hint: `tz ${g("agents.defaults.timezone")} · retry ${g("agents.defaults.providerRetryMode")}`,
        },
        { label: "Skills" },
        { label: "Usage" },
        { label: "Advanced (raw get/set)" },
        { label: "Back to chat" },
      ],
      { io: opts.io },
    );

    if (choice === null || choice === 9) return; // Esc, or "Back to chat"

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
        await toolsMenu(opts);
        break;
      case 4:
        await apiMenu(opts);
        break;
      case 5:
        await agentMenu(opts);
        break;
      case 6:
        skillsView(opts);
        break;
      case 7:
        usageView(opts);
        break;
      case 8:
        await advancedMenu(opts);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Shared setter helpers (thin wrappers over the controller's validated
// dotted get/set, so every friendly menu reuses schema validation)
// ---------------------------------------------------------------------------

/** Flip a boolean config leaf and report the result. */
function toggleBool(opts: SettingsMenuOptions, path: string, label: string): void {
  const next = !opts.controller.getValue(path);
  printResult(
    opts.io,
    opts.controller.setValue(path, String(next)),
    `${label} ${next ? "enabled" : "disabled"}.`,
  );
}

/** Prompt for free text and write it to `path` (empty allowed). */
async function setTextValue(
  opts: SettingsMenuOptions,
  path: string,
  prompt: string,
  label: string,
): Promise<void> {
  const raw = await promptText(prompt, { io: opts.io });
  if (raw === null) return;
  const trimmed = raw.trim();
  printResult(
    opts.io,
    opts.controller.setValue(path, trimmed),
    `${label} set to ${trimmed || "(empty)"}.`,
  );
}

/** Prompt for a secret (masked) and write it without echoing the value. */
async function setSecretValue(
  opts: SettingsMenuOptions,
  path: string,
  prompt: string,
  label: string,
): Promise<void> {
  const raw = await promptText(`${prompt} (masked, Esc to cancel)`, { io: opts.io, secure: true });
  if (raw === null) return;
  printResult(opts.io, opts.controller.setValue(path, raw.trim()), `${label} updated.`);
}

/** Pick one of `choices` and write it to `path`. */
async function setChoiceValue(
  opts: SettingsMenuOptions,
  path: string,
  choices: readonly string[],
  label: string,
): Promise<void> {
  const idx = await selectMenu(
    choices.map((c) => ({ label: c })),
    { io: opts.io },
  );
  if (idx === null) return;
  const v = choices[idx]!;
  printResult(opts.io, opts.controller.setValue(path, v), `${label} set to ${v}.`);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

async function toolsMenu(opts: SettingsMenuOptions): Promise<void> {
  const { controller, io } = opts;
  const g = (p: string): unknown => controller.getValue(p);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    log(io, `\n${styled("Tools", ansi.bold)}`);
    const choice = await selectMenu(
      [
        { label: "Web tools", hint: onOff(g("tools.web.enable")) },
        { label: "Web search provider", hint: String(g("tools.web.search.provider")) },
        { label: "Web search API key", hint: maskKey(String(g("tools.web.search.apiKey") ?? "")) },
        { label: "SearXNG base URL", hint: String(g("tools.web.search.baseUrl")) || "(not set)" },
        { label: "Allow private web addresses", hint: onOff(g("tools.web.allowPrivateAddresses")) },
        { label: "Shell (exec)", hint: onOff(g("tools.exec.enable")) },
        { label: "Shell timeout (s)", hint: String(g("tools.exec.timeout")) },
        { label: "Memory", hint: onOff(g("tools.memory.enable")) },
        { label: "Restrict tools to workspace", hint: onOff(g("tools.restrictToWorkspace")) },
        { label: "Back" },
      ],
      { io },
    );
    if (choice === null || choice === 9) return;

    switch (choice) {
      case 0:
        toggleBool(opts, "tools.web.enable", "Web tools");
        break;
      case 1:
        await setChoiceValue(
          opts,
          "tools.web.search.provider",
          SEARCH_PROVIDERS,
          "Search provider",
        );
        break;
      case 2:
        await setSecretValue(
          opts,
          "tools.web.search.apiKey",
          "Enter web search API key (Brave/Tavily)",
          "Search API key",
        );
        break;
      case 3:
        await setTextValue(
          opts,
          "tools.web.search.baseUrl",
          "Enter SearXNG base URL (Esc to cancel):",
          "SearXNG base URL",
        );
        break;
      case 4:
        toggleBool(opts, "tools.web.allowPrivateAddresses", "Private web addresses");
        break;
      case 5:
        toggleBool(opts, "tools.exec.enable", "Shell (exec)");
        break;
      case 6: {
        const n = await promptNumber(opts, "Enter shell timeout in seconds:");
        if (n !== null)
          printResult(
            io,
            controller.setValue("tools.exec.timeout", String(n)),
            `Shell timeout set to ${n}s.`,
          );
        break;
      }
      case 7:
        toggleBool(opts, "tools.memory.enable", "Memory");
        break;
      case 8:
        toggleBool(opts, "tools.restrictToWorkspace", "Restrict-to-workspace");
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// API server
// ---------------------------------------------------------------------------

async function apiMenu(opts: SettingsMenuOptions): Promise<void> {
  const { controller, io } = opts;
  const g = (p: string): unknown => controller.getValue(p);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    log(io, `\n${styled("API server", ansi.bold)}`);
    const choice = await selectMenu(
      [
        { label: "Host", hint: String(g("api.host")) },
        { label: "Port", hint: String(g("api.port")) },
        { label: "Bearer API key", hint: maskKey(String(g("api.apiKey") ?? "")) },
        { label: "Back" },
      ],
      { io },
    );
    if (choice === null || choice === 3) return;

    switch (choice) {
      case 0:
        await setTextValue(opts, "api.host", "Enter API host (e.g. 127.0.0.1):", "API host");
        break;
      case 1: {
        const n = await promptNumber(opts, "Enter API port (1-65535):");
        if (n !== null)
          printResult(io, controller.setValue("api.port", String(n)), `API port set to ${n}.`);
        break;
      }
      case 2:
        await setSecretValue(
          opts,
          "api.apiKey",
          "Enter the bearer token clients must send",
          "Bearer API key",
        );
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Agent (misc defaults)
// ---------------------------------------------------------------------------

async function agentMenu(opts: SettingsMenuOptions): Promise<void> {
  const { controller, io } = opts;
  const g = (p: string): unknown => controller.getValue(p);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    log(io, `\n${styled("Agent", ansi.bold)}`);
    const choice = await selectMenu(
      [
        { label: "Timezone", hint: String(g("agents.defaults.timezone")) },
        { label: "Provider retry mode", hint: String(g("agents.defaults.providerRetryMode")) },
        { label: "Max tool result chars", hint: String(g("agents.defaults.maxToolResultChars")) },
        {
          label: "Context block limit",
          hint: String(g("agents.defaults.contextBlockLimit") ?? "(none)"),
        },
        { label: "Back" },
      ],
      { io },
    );
    if (choice === null || choice === 4) return;

    switch (choice) {
      case 0:
        await setTextValue(
          opts,
          "agents.defaults.timezone",
          "Enter IANA timezone (e.g. UTC, Asia/Tashkent):",
          "Timezone",
        );
        break;
      case 1:
        await setChoiceValue(opts, "agents.defaults.providerRetryMode", RETRY_MODES, "Retry mode");
        break;
      case 2: {
        const n = await promptNumber(opts, "Enter max tool result chars:");
        if (n !== null)
          printResult(
            io,
            controller.setValue("agents.defaults.maxToolResultChars", String(n)),
            `Max tool result chars set to ${n}.`,
          );
        break;
      }
      case 3:
        await setTextValue(
          opts,
          "agents.defaults.contextBlockLimit",
          "Enter context block limit (blank or 'null' for none):",
          "Context block limit",
        );
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
  log(
    io,
    `Routing: ${o.provider}${o.provider === "auto" ? ` (resolved: ${o.resolvedProvider ?? "none"})` : ""}`,
  );

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
      if (n !== null)
        printResult(io, controller.setContextWindow(n), `Context window set to ${n}.`);
      break;
    }
    case 3: {
      const n = await promptNumber(opts, "Enter max tool iterations:");
      if (n !== null)
        printResult(io, controller.setMaxToolIterations(n), `Max tool iterations set to ${n}.`);
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
    const flags = [
      available.has(s.name) ? null : "unavailable",
      always.has(s.name) ? "always" : null,
    ].filter(Boolean);
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
  const path = await promptText(
    "Enter a dotted config path (e.g. agents.defaults.temperature), Esc to cancel:",
    {
      io,
    },
  );
  if (path === null) return;
  const trimmedPath = path.trim();
  if (!trimmedPath) return;

  const current = controller.getValue(trimmedPath);
  log(io, `Current value: ${JSON.stringify(current)}`);
  const value = await promptText("Enter new value, Esc to cancel:", { io });
  if (value === null) return;
  const trimmedValue = value.trim();
  if (!trimmedValue) return;

  printResult(
    io,
    controller.setValue(trimmedPath, trimmedValue),
    `${trimmedPath} = ${trimmedValue}`,
  );
}
