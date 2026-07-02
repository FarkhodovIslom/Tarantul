
import type { BaseChannel } from "./base.js";
import type { MessageBus } from "../bus/queue.js";

export type ChannelConstructor = new (
  config: Record<string, unknown>,
  bus: MessageBus,
) => BaseChannel;

const _registry = new Map<string, ChannelConstructor>();

/** Register a channel class by name. Built-in channels take priority. */
export function registerChannel(name: string, cls: ChannelConstructor): void {
  _registry.set(name, cls);
}

/** Get a channel class by name, or undefined if not registered. */
export function getChannelClass(name: string): ChannelConstructor | undefined {
  return _registry.get(name);
}

/** Return all registered channel names. */
export function registeredChannelNames(): string[] {
  return [..._registry.keys()];
}

/** Return a snapshot of all registered channels. */
export function allChannels(): Map<string, ChannelConstructor> {
  return new Map(_registry);
}

// ---------------------------------------------------------------------------
// Register built-in channels
// ---------------------------------------------------------------------------

// Lazy-loaded to avoid importing heavy SDKs at module load time.
// The manager calls registerBuiltins() once on startup.

let _builtinsRegistered = false;

export async function registerBuiltins(): Promise<void> {
  if (_builtinsRegistered) return;
  _builtinsRegistered = true;

  const [{ TelegramChannel }, { SlackChannel }, { DiscordChannel }] = await Promise.all([
    import("./telegram.js"),
    import("./slack.js"),
    import("./discord.js"),
  ]);

  registerChannel("telegram", TelegramChannel);
  registerChannel("slack", SlackChannel);
  registerChannel("discord", DiscordChannel);
}
