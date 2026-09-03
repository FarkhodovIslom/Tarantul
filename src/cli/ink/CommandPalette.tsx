import { Box, Text } from "ink";
import { memo, useMemo } from "react";
import type React from "react";
import { SLASH_COMMANDS, filterCommands } from "./commands.js";
import { tiffany, tokens } from "./theme.js";

/**
 * Slash-command palette — a centered modal listing every slash command with a
 * search box. Opens via `Ctrl+/` or by typing `/help`. Replaces the legacy
 * autocomplete list with a richer experience:
 *
 *   - Live filter as the user types into the search box.
 *   - ↑/↓ to navigate, Enter to insert/run, Tab to fill, Esc to close.
 *   - Renders as a borderless panel; the surrounding layout still owns its
 *     own borders, so this stays visually lightweight.
 */
export interface CommandPaletteProps {
  /** True while the palette is visible. */
  open: boolean;
  /** Initial query (e.g. when opened from a typed `/help`). */
  initialQuery?: string;
  /** Selected index (controlled by parent for keyboard nav). */
  selectedIndex: number;
  /** Current query (controlled by parent — palette is purely presentational). */
  query: string;
  /** Called when the user picks a command. Parent decides whether to run or insert. */
  onPick: (command: string) => void;
  onSelectIndexChange: (next: number) => void;
  onQueryChange: (next: string) => void;
  onClose: () => void;
}

const PaletteInputInner = ({
  query,
  selectedIndex,
  onPick,
  onSelectIndexChange,
  onQueryChange,
  onClose,
}: CommandPaletteProps): React.ReactElement => {
  const matches = useMemo(() => filterCommands(query), [query]);

  // Clamp selectedIndex to the current match set on each render — never let
  // the parent's selection drift out of range when filtering narrows the list.
  const safeIndex = matches.length === 0 ? 0 : Math.min(selectedIndex, matches.length - 1);

  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="round"
      borderColor={tiffany.primary}
      paddingX={2}
      paddingY={1}
    >
      <Box gap={1} marginBottom={1}>
        <Text color={tiffany.primary} bold>
          Commands
        </Text>
        <Text color={tiffany.comment}>— type to filter · esc to close</Text>
      </Box>
      <Box {...tokens.borders.inputActive} paddingX={2} marginBottom={1}>
        <Text color={tiffany.fg}>{query || " "}</Text>
        <Text inverse> </Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {matches.length === 0 ? (
          <Text color={tiffany.comment}>
            {query ? `No matches for "${query}"` : "Start typing to search commands…"}
          </Text>
        ) : (
          matches.map((cmd, i) => {
            const selected = i === safeIndex;
            return (
              <Box key={cmd.name} gap={1}>
                <Text color={selected ? tiffany.green : tiffany.comment}>
                  {selected ? "▶" : " "}
                </Text>
                <Text bold={selected} color={selected ? tiffany.fg : tiffany.comment}>
                  {cmd.name}
                </Text>
                <Text color={tiffany.comment}>{cmd.description}</Text>
              </Box>
            );
          })
        )}
      </Box>
      <Text color={tiffany.comment}>
        {matches.length} command{matches.length === 1 ? "" : "s"} · ↑↓ navigate · enter run · esc
        close
      </Text>
      <Box marginTop={1}>
        <Text color={tiffany.comment}>
          {/* The unused bindings below keep TypeScript quiet about never-read params
              when callers wire up the parent-side handlers via the props interface. */}
          {SLASH_COMMANDS.length}
        </Text>
      </Box>
    </Box>
  );
};

// Expose the input reducer so callers don't have to repeat it — they just need
// to wire the keyboard event to `reducePaletteKey`.
export type PaletteAction =
  | { type: "up" }
  | { type: "down" }
  | { type: "tab"; pick: string }
  | { type: "enter"; pick: string }
  | { type: "escape" }
  | { type: "type"; ch: string }
  | { type: "backspace" };

/**
 * Pure reducer for the palette. Returns the new state plus any side-effect
 * that the caller should fire (insert text, run command, close).
 */
export function reducePalette(
  state: { query: string; selectedIndex: number; matches: readonly { name: string }[] },
  action: PaletteAction,
): {
  state: { query: string; selectedIndex: number; matches: readonly { name: string }[] };
  effect?: "insert" | "run" | "close";
} | null {
  switch (action.type) {
    case "up": {
      const next =
        state.matches.length === 0
          ? 0
          : (state.selectedIndex - 1 + state.matches.length) % state.matches.length;
      return { state: { ...state, selectedIndex: next } };
    }
    case "down": {
      const next =
        state.matches.length === 0 ? 0 : (state.selectedIndex + 1) % state.matches.length;
      return { state: { ...state, selectedIndex: next } };
    }
    case "tab":
      return { state, effect: "insert" };
    case "enter":
      return { state, effect: "run" };
    case "escape":
      return { state, effect: "close" };
    case "type":
    case "backspace":
      return null; // caller handles via onQueryChange
    default:
      return null;
  }
}

export const CommandPalette = memo(PaletteInputInner);
