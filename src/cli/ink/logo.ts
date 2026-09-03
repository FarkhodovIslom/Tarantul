/**
 * OpenCode-style blocky ASCII art logo for TARANTUL.
 *
 * Each element in LOGO_LINES is one terminal row.
 * LOGO_COLORS[i] is the hex color to apply to LOGO_LINES[i],
 * creating a top-bright → bottom-dim vertical gradient.
 *
 * Font style: thick block letters built from █ ▀ ▄ ▌ ▐ ▀ characters,
 * similar to the OpenCode "opencode" logotype.
 */

export const LOGO_LINES: readonly string[] = [
  " ████████╗ █████╗ ██████╗  █████╗ ███╗   ██╗████████╗██╗   ██╗██╗     ",
  "    ██╔══╝██╔══██╗██╔══██╗██╔══██╗████╗  ██║╚══██╔══╝██║   ██║██║     ",
  "    ██║   ███████║██████╔╝███████║██╔██╗ ██║   ██║   ██║   ██║██║     ",
  "    ██║   ██╔══██║██╔══██╗██╔══██║██║╚██╗██║   ██║   ██║   ██║██║     ",
  "    ██║   ██║  ██║██║  ██║██║  ██║██║ ╚████║   ██║   ╚██████╔╝███████╗",
  "    ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝    ╚═════╝ ╚══════╝",
];

/**
 * Per-row hex colors — vertical gradient from tiffany.primary (bright teal)
 * fading to tiffany.comment (dim muted teal).
 */
export const LOGO_COLORS: readonly string[] = [
  "#0abab5", // row 0 — tiffany.primary (brightest)
  "#23b5b0", // row 1
  "#3aacaa", // row 2
  "#4a9e9a", // row 3
  "#518e8a", // row 4
  "#5c8d89", // row 5 — tiffany.comment (dimmest)
];
