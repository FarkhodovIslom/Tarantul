import { Box, Text } from "ink";
import type React from "react";
import { tiffany, tokens } from "./theme.js";

interface BaseProps {
  children: React.ReactNode;
}

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
    <Box flexDirection="column" width="100%" {...tokens.borders.window} paddingY={tokens.spacing.py}>
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
      <Text bold color={tiffany.fg}>{label}</Text>
    </Text>
  );
}