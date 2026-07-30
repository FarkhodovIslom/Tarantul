export const dracula = {
  purple: "#0ABBB5",
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

export const tiffany = {
  primary: "#0abab5",
  secondary: "#70e4d5",
  comment: "#5c8d89",
  fg: "#f0faf9",
  selection: "#18302e",
  bg: "#0d1615",
  accent: "#4ecdc4",
  green: "#6bebbf",
  red: "#ff6b6b",
  orange: "#f4a261",
} as const;

export const tokens = {
  spacing: {
    px: 2,
    py: 1,
    gap: 1,
  },
  borders: {
    window: {
      borderStyle: "single" as const,
      borderTop: true,
      borderBottom: false,
      borderLeft: false,
      borderRight: false,
      borderColor: tiffany.selection,
    },
    box: {
      borderStyle: "single" as const,
      borderColor: tiffany.selection,
    },
  },
} as const;