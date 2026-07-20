/**
 * Single source of truth for the CLI's slash commands — consumed by the
 * welcome banner and the typing-time autocomplete. Descriptions are shown in
 * both places, so keep them short.
 */

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/help", description: "show help" },
  { name: "/new", description: "start a new chat" },
  { name: "/sessions", description: "list & switch chats" },
  { name: "/status", description: "model & session status" },
  { name: "/usage", description: "token usage & cost" },
  { name: "/settings", description: "provider, model & options" },
  { name: "/stop", description: "cancel the running task" },
];

/**
 * Commands matching the current input for autocomplete. Returns [] unless the
 * input is a bare slash-token (starts with "/", no space yet) — a space means
 * the command already has arguments, so suggestions stop.
 */
export function filterCommands(input: string): SlashCommand[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/") || /\s/.test(trimmed)) return [];
  const q = trimmed.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}
