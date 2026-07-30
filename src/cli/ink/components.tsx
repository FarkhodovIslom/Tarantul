import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { markdownToAnsi, toolCallLabel } from "../render.js";
import { SLASH_COMMANDS, type SlashCommand } from "./commands.js";
import { tiffany } from "./theme.js";
import type { RunningTool, SelectorSpec, TranscriptItem } from "./types.js";

/**
 * OpenCode-style spatial layout powered by Tiffany theme tokens.
 * High negative space, crisp hierarchy, clean text markers.
 */

const BLOCK_LOGO: readonly string[] = [
  `█████████████████████████████████████████████████`,
  `█               T A R A N T U L                 █`,
  `█████████████████████████████████████████████████`,
];

export function Banner({ version, model }: { version: string; model: string }): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center" paddingY={2} width="100%">
      {BLOCK_LOGO.map((line, i) => (
        <Text key={`logo-line-${i}`} color={tiffany.primary}>
          {line}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text bold color={tiffany.secondary}>{`v${version}`}</Text>
        <Text color={tiffany.comment}>{` · ${model}`}</Text>
      </Box>

      <Box marginTop={2} flexDirection="column" width={48}>
        {SLASH_COMMANDS.map((c) => (
          <Box key={c.name} justifyContent="space-between" width="100%">
            <Text color={tiffany.primary}>{c.name}</Text>
            <Text color={tiffany.comment}>{c.description}</Text>
          </Box>
        ))}
        <Box justifyContent="space-between" width="100%">
          <Text color={tiffany.primary}>exit</Text>
          <Text color={tiffany.comment}>quit application</Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Top-bordered block for messages/assistant output.
 * Clean tiling window manager layout with Tiffany accents.
 */
function WindowBlock({
  children,
  header,
}: {
  children: React.ReactNode;
  header?: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="single"
      borderColor={tiffany.selection}
      borderRight={false}
      borderLeft={false}
      borderBottom={false}
      paddingY={1}
      paddingX={2}
      marginBottom={1}
    >
      {header ? <Box marginBottom={1}>{header}</Box> : null}
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}

/** A completed tool line with simple ASCII status markers. */
export function ToolLine({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}): React.ReactElement {
  const summary = (detail.split("\n")[0] ?? "").trim();
  const capped = summary.length > 100 ? `${summary.slice(0, 99)}…` : summary;
  return (
    <Box flexDirection="column" paddingX={2} marginBottom={1}>
      <Text>
        <Text color={ok ? tiffany.green : tiffany.red}>{ok ? "[+] " : "[-] "}</Text>
        <Text bold color={tiffany.fg}>{label}</Text>
      </Text>
      {capped ? <Text color={tiffany.comment}>{`  └─ ${capped}`}</Text> : null}
    </Box>
  );
}

/** Render one finalized transcript item. */
export function Item({ item }: { item: TranscriptItem }): React.ReactElement {
  switch (item.kind) {
    case "user":
      return (
        <Box flexDirection="column" width="100%" paddingX={2} marginY={1}>
          <Box
            backgroundColor={tiffany.selection}
            paddingX={2}
            paddingY={1}
            width="100%"
          >
            <Text color={tiffany.primary} bold>{"❯ You: "}</Text>
            <Text color={tiffany.fg}>{item.text}</Text>
          </Box>
        </Box>
      );
    case "assistant":
      return (
        <WindowBlock
          header={
            <Box gap={1}>
              <Text color={tiffany.secondary} bold>{"✦ Assistant"}</Text>
              {item.model ? (
                <Text color={tiffany.comment}>{`(${item.model} · ${item.time})`}</Text>
              ) : null}
            </Box>
          }
        >
          <Text color={tiffany.fg}>{markdownToAnsi(item.text)}</Text>
        </WindowBlock>
      );
    case "tool":
      return <ToolLine label={item.label} ok={item.ok} detail={item.detail} />;
    case "notice":
      return (
        <Box paddingX={2} marginBottom={1}>
          <Text color={item.tone === "error" ? tiffany.red : tiffany.comment}>{`! ${item.text}`}</Text>
        </Box>
      );
  }
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ label }: { label: string }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const [start] = useState(() => Date.now());
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    const t = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      setSecs(Math.floor((Date.now() - start) / 1000));
    }, 80);
    return () => clearInterval(t);
  }, [start]);

  return (
    <Box paddingX={2} paddingY={1} gap={1}>
      <Text color={tiffany.secondary} bold>{SPINNER_FRAMES[frame]}</Text>
      <Text color={tiffany.comment}>{`${label} (${secs}s)`}</Text>
    </Box>
  );
}

export function LiveRegion({
  assistant,
  tools,
  busy,
  busyLabel,
}: {
  assistant: string;
  tools: RunningTool[];
  busy: boolean;
  busyLabel: string | null;
}): React.ReactElement | null {
  if (!busy && !assistant && tools.length === 0) return null;
  return (
    <Box flexDirection="column" width="100%">
      {tools.map((t) => (
        <Box key={t.id} paddingX={2} gap={1}>
          <Text color={tiffany.secondary}>⚙️</Text>
          <Text bold color={tiffany.fg}>{t.label}</Text>
        </Box>
      ))}
      {assistant ? (
        <WindowBlock header={<Text color={tiffany.secondary} bold>{"✦ Assistant"}</Text>}>
          <Text color={tiffany.fg}>{markdownToAnsi(assistant)}</Text>
        </WindowBlock>
      ) : null}
      {busy ? <Spinner label={busyLabel ?? (assistant ? "Writing…" : "Thinking…")} /> : null}
    </Box>
  );
}

/**
 * Native application style input container with Tiffany background block,
 * breathable vertical padding, and discrete status rows.
 */
export function InputBar({
  value,
  cursor,
  hintRight,
  statusLeft,
  statusRight,
  disabled,
}: {
  value: string;
  cursor: number;
  hintRight: string;
  statusLeft: string;
  statusRight: string;
  disabled: boolean;
}): React.ReactElement {
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || " ";
  const after = value.slice(cursor + 1);

  return (
    <Box flexDirection="column" width="100%" paddingX={2} marginTop={1} marginBottom={1}>
      <Box
        backgroundColor={disabled ? tiffany.bg : tiffany.selection}
        paddingX={2}
        paddingY={1}
        width="100%"
      >
        <Text color={disabled ? tiffany.comment : tiffany.primary}>{"> "}</Text>
        <Text color={tiffany.fg}>{before}</Text>
        <Text inverse>{at}</Text>
        <Text color={tiffany.fg}>{after}</Text>
      </Box>
      <Box justifyContent="space-between" width="100%" marginTop={1}>
        <Text color={tiffany.comment}>
          {disabled ? "ctrl+c to cancel" : "enter send · /help commands · exit quit"}
        </Text>
        <Text color={tiffany.comment}>{hintRight}</Text>
      </Box>
      <Box justifyContent="space-between" width="100%">
        <Text color={tiffany.comment}>{statusLeft}</Text>
        <Text color={tiffany.comment}>{statusRight}</Text>
      </Box>
    </Box>
  );
}

export function SelectPrompt({
  spec,
  selectedIndex,
}: {
  spec: SelectorSpec;
  selectedIndex: number;
}): React.ReactElement {
  const accent = spec.accent === "warn" ? tiffany.orange : tiffany.primary;
  const hint = spec.hint ?? "↑↓ select · enter confirm · esc cancel";
  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="single"
      borderColor={accent}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      <Text color={accent} bold>{spec.title}</Text>
      {(spec.body ?? []).map((line) => (
        <Text key={line} color={tiffany.comment}>{line}</Text>
      ))}
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {spec.options.map((opt, i) => {
          const selected = i === selectedIndex;
          return (
            <Text key={`${opt.label}-${i}`}>
              <Text color={tiffany.green}>{selected ? "[x] " : "[ ] "}</Text>
              <Text color={selected ? tiffany.fg : tiffany.comment} bold={selected}>
                {opt.label}
              </Text>
              {opt.detail ? <Text color={tiffany.comment}>{`  ${opt.detail}`}</Text> : null}
            </Text>
          );
        })}
      </Box>
      <Text color={tiffany.comment}>{hint}</Text>
    </Box>
  );
}

export function SuggestionList({
  items,
  selectedIndex,
}: {
  items: readonly SlashCommand[];
  selectedIndex: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={2} marginBottom={1}>
      {items.map((c, i) => {
        const selected = i === selectedIndex;
        return (
          <Box key={c.name} width={48} justifyContent="space-between">
            <Text color={selected ? tiffany.green : tiffany.comment}>
              {selected ? `> ${c.name}` : `  ${c.name}`}
            </Text>
            <Text color={tiffany.comment}>{c.description}</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={tiffany.comment}>↑↓ select · tab complete · enter run · esc dismiss</Text>
      </Box>
    </Box>
  );
}

export { toolCallLabel };