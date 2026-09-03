import { Box, Text } from "ink";
import { memo } from "react";
import type React from "react";
import { layout, tiffany } from "./theme.js";

/**
 * Top title bar — macOS-style traffic lights + app name + active model.
 *
 * Pinned to the very top of the screen. Uses `layout.titleBar` tokens.
 * The three colored dots are purely decorative (no click handlers); they're
 * a spatial cue familiar from native macOS / Linux title bars.
 */
export interface TitleBarProps {
  /** Right-aligned meta (typically `v<version>`). */
  version: string;
  /** Active model name (centered between traffic lights and version). */
  model: string;
}

export const TitleBar = memo(function TitleBar({
  version,
  model,
}: TitleBarProps): React.ReactElement {
  return (
    <Box
      width="100%"
      backgroundColor={layout.titleBar.bg}
      paddingX={2}
      justifyContent="space-between"
      flexShrink={0}
    >
      <Box gap={1}>
        <Text color={layout.titleBar.trafficRed}>●</Text>
        <Text color={layout.titleBar.trafficYellow}>●</Text>
        <Text color={layout.titleBar.trafficGreen}>●</Text>
      </Box>
      <Text color={layout.titleBar.fg} bold>
        Tarantul
      </Text>
      <Box gap={2}>
        <Text color={tiffany.secondary}>{model}</Text>
        <Text color={layout.titleBar.fg}>{`v${version}`}</Text>
      </Box>
    </Box>
  );
});
