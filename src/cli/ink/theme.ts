/**
 * Dracula palette as hex strings. Ink (via chalk) downgrades truecolor to
 * 256/16 colors automatically per the terminal's capabilities, so unlike the
 * legacy readline renderer we don't quantize by hand here.
 */
export const dracula = {
  purple: "#bd93f9",
  pink: "#ff79c6",
  cyan: "#8be9fd",
  green: "#50fa7b",
  red: "#ff5555",
  orange: "#ffb86c",
  yellow: "#f1fa8c",
  comment: "#6272a4",
  fg: "#f8f8f2",
  selection: "#44475a",
  bg: "#282a36",
} as const;
