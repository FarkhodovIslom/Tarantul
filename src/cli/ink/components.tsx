import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { markdownToAnsi, toolCallLabel } from "../render.js";
import { SLASH_COMMANDS, type SlashCommand } from "./commands.js";
import { dracula } from "./theme.js";
import type { RunningTool, SelectorSpec, TranscriptItem } from "./types.js";

/** Two-tone block logotype (matches the legacy renderer). */
const BLOCK_LOGO: [string, string] = [
  "▀█▀ ▄▀▄ █▀▄ ▄▀▄ █▀█ ▀█▀ █ █ █  ",
  " █  █▀█ █▀▄ █▀█ █ █  █  █▄█ █▄▄",
];
const LOGO_SPLIT = 20;

export function Banner({ version, model }: { version: string; model: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {BLOCK_LOGO.map((line) => (
        <Text key={line}>
          <Text color={dracula.comment}>{line.slice(0, LOGO_SPLIT)}</Text>
          <Text color={dracula.purple}>{line.slice(LOGO_SPLIT)}</Text>
        </Text>
      ))}
      <Text color={dracula.comment}>{`🕷️ v${version} · ${model}`}</Text>
      <Box marginTop={1} flexDirection="column">
        {SLASH_COMMANDS.map((c) => (
          <Text key={c.name}>
            <Text color={dracula.purple}>{c.name.padEnd(12)}</Text>
            <Text color={dracula.comment}>{c.description}</Text>
          </Text>
        ))}
        <Text key="exit">
          <Text color={dracula.purple}>{"exit".padEnd(12)}</Text>
          <Text color={dracula.comment}>quit</Text>
        </Text>
      </Box>
    </Box>
  );
}

/** Left-accent-bordered block used for user + assistant messages. */
function BorderedBlock({
  color,
  children,
}: {
  color: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      borderStyle="single"
      borderColor={color}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
      marginBottom={1}
    >
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}

/** A completed tool line: colored ⏺ bullet + label, with a dim ⎿ result. */
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
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={ok ? dracula.green : dracula.red}>⏺ </Text>
        <Text bold>{label}</Text>
      </Text>
      {capped ? <Text color={dracula.comment}>{`  ⎿ ${capped}`}</Text> : null}
    </Box>
  );
}

/** Render one finalized transcript item. */
export function Item({ item }: { item: TranscriptItem }): React.ReactElement {
  switch (item.kind) {
    case "user":
      // Compact, unbordered echo — deliberately structured differently from
      // the assistant's bordered block (not just a different border color)
      // so the two stay distinguishable even in low-color terminals.
      return (
        <Box marginBottom={1}>
          <Text color={dracula.pink}>{"> "}</Text>
          <Text color={dracula.pink}>{item.text}</Text>
        </Box>
      );
    case "assistant":
      // Footer only when a model is known — mid-turn flushes and replayed
      // history carry an empty model and must not render a bare " ()" line.
      return (
        <BorderedBlock color={dracula.purple}>
          <Text>
            <Text color={dracula.purple}>{"⏺ "}</Text>
            {markdownToAnsi(item.text)}
          </Text>
          {item.model ? (
            <Text color={dracula.comment}>{`${item.model} (${item.time})`}</Text>
          ) : null}
        </BorderedBlock>
      );
    case "tool":
      return <ToolLine label={item.label} ok={item.ok} detail={item.detail} />;
    case "notice":
      return (
        <Box marginBottom={1}>
          <Text color={item.tone === "error" ? dracula.red : dracula.comment}>{item.text}</Text>
        </Box>
      );
  }
}

/**
 * Spinner glyph packs. One is picked at random per process start (not per
 * spinner instance, so it stays consistent for the whole run) rather than
 * hard-coding a single fixed set — the old `✢ ✳ ✻ ✽` pulse read as a
 * straight Claude Code lookalike.
 */
const SPINNER_PACKS: readonly (readonly string[])[] = [
  ["⭑", "✶", "✷", "✸", "✹"],
  ["☆", "★", "✮", "★", "☆"],
  ["𒅒", "𒈔", "𒅒", "𒇫", "𒄆"],
  ["𓆝", "𓆟", "𓆞", "𓆝", "𓆟"],
  ["🂡", "🂱", "🃁", "🃑", "🃟"],
  ["◐", "◓", "◑", "◒", "◐"],
];

const SPINNER_FRAMES: readonly string[] =
  SPINNER_PACKS[Math.floor(Math.random() * SPINNER_PACKS.length)] ?? SPINNER_PACKS[0]!;

/** Pulsing-asterisk spinner with an elapsed-seconds suffix. */
export function Spinner({ label }: { label: string }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const [start] = useState(() => Date.now());
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      setSecs(Math.floor((Date.now() - start) / 1000));
    }, 120);
    return () => clearInterval(t);
  }, [start]);
  return (
    <Text>
      <Text color={dracula.purple}>{SPINNER_FRAMES[frame]}</Text>
      <Text color={dracula.comment}>{` ${label} (${secs}s)`}</Text>
    </Text>
  );
}

/** The in-progress region: running tools, streaming text, and a spinner. */
export function LiveRegion({
  assistant,
  tools,
  busy,
  busyLabel,
}: {
  assistant: string;
  tools: RunningTool[];
  busy: boolean;
  /** Override for the spinner label (e.g. "Summarizing session…"); null = default. */
  busyLabel: string | null;
}): React.ReactElement | null {
  if (!busy && !assistant && tools.length === 0) return null;
  return (
    <Box flexDirection="column">
      {tools.map((t) => (
        <Text key={t.id}>
          <Text color={dracula.purple}>⏺ </Text>
          <Text bold>{t.label}</Text>
        </Text>
      ))}
      {assistant ? (
        <BorderedBlock color={dracula.purple}>
          <Text>
            <Text color={dracula.purple}>{"⏺ "}</Text>
            {markdownToAnsi(assistant)}
          </Text>
        </BorderedBlock>
      ) : null}
      {busy ? <Spinner label={busyLabel ?? (assistant ? "Writing…" : "Thinking…")} /> : null}
    </Box>
  );
}

/** Bottom-docked tinted input bar + hint row + status row. */
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
    <Box flexDirection="column">
      <Box backgroundColor={dracula.selection} paddingX={1}>
        <Text color={disabled ? dracula.comment : dracula.pink}>{"> "}</Text>
        <Text color={dracula.fg}>{before}</Text>
        {disabled ? null : <Text inverse>{at}</Text>}
        <Text color={dracula.fg}>{after}</Text>
      </Box>
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={dracula.comment}>
          {disabled ? "ctrl+c stop" : "enter send · /help commands · exit quit"}
        </Text>
        <Text color={dracula.comment}>{hintRight}</Text>
      </Box>
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={dracula.comment}>{statusLeft}</Text>
        <Text color={dracula.comment}>{statusRight}</Text>
      </Box>
    </Box>
  );
}

/**
 * Generic arrow-key selector shown in place of the input bar — reused by the
 * permission prompt, the summarize-on-leave confirm, and the /sessions picker.
 * Purely presentational; selection state lives in the parent (App).
 */
export function SelectPrompt({
  spec,
  selectedIndex,
}: {
  spec: SelectorSpec;
  selectedIndex: number;
}): React.ReactElement {
  const accent = spec.accent === "warn" ? dracula.orange : dracula.purple;
  const hint = spec.hint ?? "↑↓ select · enter confirm · esc cancel";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      <Text color={accent}>{spec.title}</Text>
      {(spec.body ?? []).map((line) => (
        <Text key={line} color={dracula.comment}>
          {line}
        </Text>
      ))}
      <Box flexDirection="column" marginTop={1}>
        {spec.options.map((opt, i) => {
          const selected = i === selectedIndex;
          return (
            <Text key={`${opt.label}-${i}`}>
              <Text color={dracula.green}>{selected ? "• " : "  "}</Text>
              <Text color={selected ? dracula.fg : dracula.comment} bold={selected}>
                {opt.label}
              </Text>
              {opt.detail ? <Text color={dracula.comment}>{`  ${opt.detail}`}</Text> : null}
            </Text>
          );
        })}
      </Box>
      <Text color={dracula.comment}>{hint}</Text>
    </Box>
  );
}

/** Typing-time slash-command autocomplete list, shown above the input bar. */
export function SuggestionList({
  items,
  selectedIndex,
}: {
  items: readonly SlashCommand[];
  selectedIndex: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {items.map((c, i) => {
        const selected = i === selectedIndex;
        return (
          <Text key={c.name}>
            <Text color={dracula.green}>{selected ? "• " : "  "}</Text>
            <Text color={selected ? dracula.fg : dracula.purple} bold={selected}>
              {c.name.padEnd(12)}
            </Text>
            <Text color={dracula.comment}>{c.description}</Text>
          </Text>
        );
      })}
      <Text color={dracula.comment}>↑↓ select · tab complete · enter run · esc dismiss</Text>
    </Box>
  );
}

/** Re-export so callers building tool labels don't reach past this module. */
export { toolCallLabel };
