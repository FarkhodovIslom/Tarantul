/**
 * First-run onboarding wizard. Runs in the terminal the first time the user
 * launches `tarantul agent` with no config file (and from `tarantul onboard`),
 * walking them through provider → API key → model with the same arrow-key /
 * masked-input primitives as the `/settings` menu (see keyboard.ts). Every
 * step is applied through {@link SettingsController}, so choices validate and
 * persist to disk exactly like a later settings edit.
 *
 * A config file is written up front (defaults) so a skipped or partial run
 * still leaves a usable file and the wizard never nags on the next launch.
 */

import { saveConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { SettingsController } from "../config/settings.js";
import { findByName } from "../providers/registry.js";
import {
  type KeyboardIO,
  beginKeyboardSession,
  endKeyboardSession,
  promptText,
  selectMenu,
} from "./keyboard.js";
import { ansi, styled } from "./render.js";

const LOGO = "🕷️";

// ---------------------------------------------------------------------------
// Curated provider shortlist (the full 25-provider registry is reachable via
// the "Other…" entry). Ordered by how commonly people reach for them.
// ---------------------------------------------------------------------------

interface CuratedProvider {
  name: string;
  defaultModel: string;
  keyUrl?: string;
  note?: string;
}

const CURATED: CuratedProvider[] = [
  {
    name: "anthropic",
    defaultModel: "claude-opus-4-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  { name: "openai", defaultModel: "gpt-4o", keyUrl: "https://platform.openai.com/api-keys" },
  {
    name: "openrouter",
    defaultModel: "anthropic/claude-opus-4-5",
    keyUrl: "https://openrouter.ai/keys",
    note: "many models, one key",
  },
  { name: "gemini", defaultModel: "gemini-2.5-pro", keyUrl: "https://aistudio.google.com/apikey" },
  {
    name: "deepseek",
    defaultModel: "deepseek-chat",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    name: "groq",
    defaultModel: "llama-3.3-70b-versatile",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    name: "mistral",
    defaultModel: "mistral-large-latest",
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  { name: "ollama", defaultModel: "llama3.1", note: "local, no key" },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OnboardingOptions {
  configPath: string;
  /** Config to mutate + save — pass fresh defaults on first run. */
  baseConfig: Config;
  /** Injectable for tests; defaults to process.stdin/stdout. */
  io?: KeyboardIO;
}

export interface OnboardingResult {
  /** True once a provider was chosen (with or without a key); false on a full skip. */
  completed: boolean;
  config: Config;
}

interface ProviderChoice {
  name: string;
  label: string;
  defaultModel: string;
  needsKey: boolean;
  keyUrl?: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runOnboarding(opts: OnboardingOptions): Promise<OnboardingResult> {
  beginKeyboardSession();
  try {
    return await onboardingFlow(opts);
  } finally {
    endKeyboardSession();
  }
}

function providerNeedsKey(name: string): boolean {
  const spec = findByName(name);
  return !(spec?.isLocal || spec?.isOauth);
}

async function onboardingFlow(opts: OnboardingOptions): Promise<OnboardingResult> {
  const { configPath, baseConfig, io } = opts;
  const out = (text: string): void => {
    (io?.output ?? process.stdout).write(`${text}\n`);
  };

  // Leave a usable config on disk even if the user skips the rest.
  saveConfig(baseConfig, configPath);
  const controller = new SettingsController(baseConfig, configPath);

  out(`\n${LOGO}  ${styled("Welcome to tarantul", ansi.bold)}`);
  out(styled("A quick setup to get your assistant talking to a model.", ansi.dim));
  out(styled("Press Esc at any step to skip and finish later with /settings.\n", ansi.dim));

  // --- Step 1: provider ----------------------------------------------------
  const provider = await pickProvider(opts);
  if (!provider) {
    out(styled("\nSkipped — run `tarantul onboard` or use /settings when ready.", ansi.yellow));
    return { completed: false, config: baseConfig };
  }
  controller.setProvider(provider.name);

  // --- Step 2: API key (skipped for local/oauth providers) -----------------
  if (provider.needsKey) {
    out(`\n${styled(`Step 2 — API key for ${provider.label}`, ansi.bold)}`);
    if (provider.keyUrl) out(styled(`Get one at: ${provider.keyUrl}`, ansi.dim));
    const key = await promptText("Paste your API key (input is masked; Esc to skip):", {
      io,
      secure: true,
    });
    const trimmed = key?.trim();
    if (trimmed) {
      controller.setApiKey(provider.name, trimmed);
      out(styled("✓ API key saved.", ansi.green));
    } else {
      out(styled("No key set — add one later with /settings.", ansi.yellow));
    }
  } else {
    out(`\n${styled(`${provider.label} runs locally — no API key needed.`, ansi.dim)}`);
  }

  // --- Step 3: model -------------------------------------------------------
  out(`\n${styled("Step 3 — Model", ansi.bold)}`);
  if (provider.defaultModel) out(`Default: ${styled(provider.defaultModel, ansi.cyan)}`);
  const modelPrompt = provider.defaultModel
    ? "Press Enter to accept the default, or type a model id:"
    : "Enter a model id:";
  const modelInput = await promptText(modelPrompt, { io });
  const model = modelInput?.trim() || provider.defaultModel;
  if (model) {
    controller.setModel(model);
    out(styled(`✓ Model set to ${model}.`, ansi.green));
  }

  out(`\n${styled("✓ Setup complete!", ansi.green)}`);
  out(`Config saved to ${styled(configPath, ansi.cyan)}`);
  out(styled("Tip: type /settings anytime to tweak providers, tools, and more.\n", ansi.dim));
  return { completed: true, config: baseConfig };
}

// ---------------------------------------------------------------------------
// Step 1 helper — choose a provider (curated list + "Other…" free entry)
// ---------------------------------------------------------------------------

async function pickProvider(opts: OnboardingOptions): Promise<ProviderChoice | null> {
  const { io } = opts;
  const out = (text: string): void => {
    (io?.output ?? process.stdout).write(`${text}\n`);
  };

  const options = CURATED.map((c) => {
    const spec = findByName(c.name);
    const hint = c.note ?? (providerNeedsKey(c.name) ? "API key needed" : "no key");
    return { label: spec?.label ?? c.name, hint };
  });
  options.push({ label: "Other…", hint: "type any of the 25 supported providers" });

  // Loop so an unknown "Other…" name re-shows the list instead of aborting.
  while (true) {
    out(styled("Step 1 — Choose your LLM provider", ansi.bold));
    const idx = await selectMenu(options, { io });
    if (idx === null) return null;

    if (idx < CURATED.length) {
      const c = CURATED[idx]!;
      const spec = findByName(c.name);
      return {
        name: c.name,
        label: spec?.label ?? c.name,
        defaultModel: c.defaultModel,
        needsKey: providerNeedsKey(c.name),
        ...(c.keyUrl ? { keyUrl: c.keyUrl } : {}),
      };
    }

    // "Other…": free-text provider name, validated against the registry.
    const raw = await promptText("Provider name (e.g. groq, ollama, mistral), Esc to go back:", {
      io,
    });
    if (raw === null) continue;
    const spec = findByName(raw.trim());
    if (!spec) {
      out(styled(`✗ Unknown provider '${raw.trim()}'. Pick from the list.`, ansi.red));
      continue;
    }
    return {
      name: spec.name,
      label: spec.label,
      defaultModel: "",
      needsKey: !(spec.isLocal || spec.isOauth),
    };
  }
}
