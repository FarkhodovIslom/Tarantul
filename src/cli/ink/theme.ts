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
  yellow: "#f1fa8c",
} as const;

// ---------------------------------------------------------------------------
// Semantic layout tokens — each fixed UI zone has its own color set.
// These drive TitleBar, InputBar, StatusBar, TipBar, and the scroll thumb.
// ---------------------------------------------------------------------------

export const layout = {
  /** Top window title bar — macOS-style traffic lights + centered app name. */
  titleBar: {
    bg: "#111d1c",
    fg: "#c8d8d6",
    trafficRed: "#ff5f56",
    trafficYellow: "#ffbd2e",
    trafficGreen: "#27c93f",
  },
  /** Bordered input box container. */
  inputBox: {
    bg: "#0f1e1c",
    borderActive: "#2a5a54",
    borderIdle: "#1a3a36",
    placeholder: "#3d6b65",
    cursor: tiffany.primary,
  },
  /** Bottom status bar (workspace + version). */
  statusBar: {
    bg: "#090e0d",
    fg: "#3d6b65",
    highlight: "#5c8d89",
  },
  /** Scroll thumb rendered as right-edge unicode braille/block characters. */
  scrollbar: {
    track: "#0f1e1c",
    thumb: "#2a5a54",
  },
  /** Tip line shown between hints row and status bar. */
  tipBar: {
    dot: "#f4a261",
    label: "#f4a261",
    text: "#5c8d89",
  },
  /** Model/agent badge row inside the input box. */
  badge: {
    pillBg: "#142926",
    pillBorder: "#204440",
    mode: tiffany.primary,
    model: tiffany.fg,
    contextLabel: tiffany.secondary,
  },
  /** Action button pill (Send / Stop / Enter) inside input box. */
  actionButton: {
    sendBg: "#18302e",
    sendFg: tiffany.green,
    stopBg: "#2b1818",
    stopFg: tiffany.orange,
    idleFg: "#3d6b65",
  },
} as const;

// ---------------------------------------------------------------------------
// Row-height constants — used by App.tsx to compute the scrollable viewport:
//   contentHeight = terminalRows - rows.pinned - liveRows
//
// The named constants track the actual rendered geometry of each pinned zone.
// `inputZone` aggregates the InputBar block (marginTop 1 + card 3 + meta 2)
// so callers can treat the whole bottom block as a single budget.
//
// Note: TitleBar is currently disabled in App.tsx (commented out); keeping
// `titleBar: 0` here so the budget stays accurate until it is re-wired.
// ---------------------------------------------------------------------------

export const rows = {
  /** TitleBar — 0 while disabled, 1 when wired back in. */
  titleBar: 0,
  /** InputBar block: marginTop 1 + bordered card 3 + hints row (marginTop 1 + 1) = 6. */
  inputZone: 6,
  /** "● Tip ..." line. */
  tipBar: 1,
  /** Bottom "path:branch  version" status bar. */
  statusBar: 1,
  /** Total rows consumed by all pinned (non-scroll) zones. */
  get pinned(): number {
    return this.titleBar + this.inputZone + this.tipBar + this.statusBar;
  },
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
    inputActive: {
      borderStyle: "round" as const,
      borderColor: layout.inputBox.borderActive,
    },
    inputIdle: {
      borderStyle: "round" as const,
      borderColor: layout.inputBox.borderIdle,
    },
  },
} as const;
