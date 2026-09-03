import { Box, Text } from "ink";
import type React from "react";
import { useState } from "react";
import { layout, tiffany, tokens } from "./theme.js";

interface BaseProps {
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Fixed pinned zones — StatusBar, TipBar
// ---------------------------------------------------------------------------

/**
 * Bottom status bar — workspace path on the left, version on the right.
 * Always rendered as the very last row of the layout.
 */
export function StatusBar({
  left,
  right,
}: {
  left: string;
  right: string;
}): React.ReactElement {
  return (
    <Box
      width="100%"
      backgroundColor={layout.statusBar.bg}
      paddingX={2}
      justifyContent="space-between"
    >
      <Text color={layout.statusBar.highlight}>{left}</Text>
      <Text color={layout.statusBar.fg}>{right}</Text>
    </Box>
  );
}

const TIPS: readonly string[] = [
  "Use /model to switch between AI providers",
  "Use /sessions to switch or create chat sessions",
  "Use /new to start a fresh conversation",
  "Use /status to see model and session info",
  "Press ctrl+c to cancel a running task",
  "Use /delete to remove a saved chat",
  "Use /usage to see token usage and cost",
];

/**
 * A randomly-chosen tip shown between the keyboard-hints row and the
 * status bar. The tip is picked once on mount and stays stable.
 */
export function TipBar(): React.ReactElement {
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)] ?? TIPS[0]!);
  return (
    <Box paddingX={2}>
      <Text color={layout.tipBar.dot}>{"● "}</Text>
      <Text color={layout.tipBar.label} bold>
        {"Tip "}
      </Text>
      <Text color={layout.tipBar.text}>{tip}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Reusable layout primitives
// ---------------------------------------------------------------------------

/** Asosiy yon padding va bo'shliq konteyneri */
export function Container({ children }: BaseProps): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%" paddingX={tokens.spacing.px} marginBottom={1}>
      {children}
    </Box>
  );
}

/** OpenCode uslubidagi top-border panel */
export function WindowPanel({
  children,
  header,
}: BaseProps & { header?: React.ReactNode }): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width="100%"
      {...tokens.borders.window}
      paddingY={tokens.spacing.py}
    >
      {header ? <Box marginBottom={1}>{header}</Box> : null}
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}

/** Status va Tool belgilari uchun indikator */
export function Badge({
  type,
  label,
}: {
  type: "success" | "error" | "pending" | "info";
  label: string;
}): React.ReactElement {
  const config = {
    success: { symbol: "[✓]", color: tiffany.green },
    error: { symbol: "[×]", color: tiffany.red },
    pending: { symbol: "[~]", color: tiffany.secondary },
    info: { symbol: "[!]", color: tiffany.orange },
  }[type];

  return (
    <Text>
      <Text color={config.color}>{`${config.symbol} `}</Text>
      <Text bold color={tiffany.fg}>
        {label}
      </Text>
    </Text>
  );
}
