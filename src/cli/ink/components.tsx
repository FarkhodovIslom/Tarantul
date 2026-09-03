import { Box, Text } from "ink";
import { memo, useEffect, useState } from "react";
import type React from "react";
import { markdownToAnsi, toolCallLabel } from "../render.js";
import type { SlashCommand } from "./commands.js";
import { LOGO_COLORS, LOGO_LINES } from "./logo.js";
import { layout, tiffany, tokens } from "./theme.js";
import type { RunningTool, SelectorSpec, TranscriptItem } from "./types.js";

/**
 * OpenCode-style spatial layout powered by Tiffany theme tokens.
 * High negative space, crisp hierarchy, gradient logo, native-app feel.
 *
 * All components are wrapped in `React.memo` so an input keystroke or a single
 * streaming delta does not re-evaluate the whole transcript.
 */

// ---------------------------------------------------------------------------
// Banner — gradient ASCII art logo shown once on startup
// ---------------------------------------------------------------------------

export const Banner = memo(function Banner({
  version,
  model,
}: {
  version: string;
  model: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center" paddingY={3} width="100%">
      {LOGO_LINES.map((line, i) => (
        <Text key={`logo-${i}`} color={LOGO_COLORS[i] ?? tiffany.primary}>
          {line}
        </Text>
      ))}
      <Box marginTop={2} gap={1}>
        <Text bold color={tiffany.secondary}>{`v${version}`}</Text>
        <Text color={tiffany.comment}>{"·"}</Text>
        <Text color={tiffany.comment}>{model}</Text>
      </Box>
    </Box>
  );
});

// ---------------------------------------------------------------------------
// Transcript items
// ---------------------------------------------------------------------------

/** A completed tool line with simple ASCII status markers. */
const ToolLineInner = ({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}): React.ReactElement => {
  const summary = (detail.split("\n")[0] ?? "").trim();
  const capped = summary.length > 100 ? `${summary.slice(0, 99)}…` : summary;
  return (
    <Box flexDirection="column" paddingX={2} marginBottom={1}>
      <Text>
        <Text color={ok ? tiffany.green : tiffany.red}>{ok ? "[✓] " : "[×] "}</Text>
        <Text bold color={tiffany.fg}>
          {label}
        </Text>
      </Text>
      {capped ? <Text color={tiffany.comment}>{`  └─ ${capped}`}</Text> : null}
    </Box>
  );
};

export const ToolLine = memo(
  ToolLineInner,
  (prev, next) => prev.label === next.label && prev.ok === next.ok && prev.detail === next.detail,
);

/** Render one finalized transcript item. */
const ItemInner = ({
  item,
  renderedText,
}: {
  item: TranscriptItem;
  /**
   * When the caller (MemoizedItem) already cached the markdown-to-ANSI render,
   * it passes the rendered string here to skip a redundant pass. When
   * undefined, Item falls back to rendering `item.text` inline.
   */
  renderedText?: string;
}): React.ReactElement => {
  switch (item.kind) {
    case "user":
      return (
        <Box flexDirection="column" width="100%" paddingX={2} marginTop={1} marginBottom={1}>
          <Box marginBottom={1}>
            <Text color={tiffany.selection}>{"─".repeat(48)}</Text>
          </Box>
          <Box gap={1}>
            <Text color={tiffany.primary} bold>
              {"⬩➤ "}
            </Text>
            <Text color={tiffany.fg}>{item.text}</Text>
          </Box>
        </Box>
      );
    case "assistant": {
      // Prefer the cached render; only fall back to a fresh markdown pass when
      // the caller didn't supply one (e.g. the memo wrapper is bypassed).
      const rendered = renderedText ?? markdownToAnsi(item.text);
      return (
        <Box flexDirection="column" width="100%" paddingX={2} marginBottom={1}>
          <Box gap={1} marginBottom={1}>
            <Text color={tiffany.secondary} bold>
              {"✦ Assistant"}
            </Text>
            {item.model ? (
              <Text color={tiffany.comment}>{`(${item.model} · ${item.time})`}</Text>
            ) : null}
          </Box>
          <Text color={tiffany.fg}>{rendered}</Text>
        </Box>
      );
    }
    case "tool":
      return <ToolLine label={item.label} ok={item.ok} detail={item.detail} />;
    case "notice":
      return (
        <Box paddingX={2} marginBottom={1}>
          <Text color={item.tone === "error" ? tiffany.red : tiffany.comment}>
            {`! ${item.text}`}
          </Text>
        </Box>
      );
  }
};

export const Item = memo(
  ItemInner,
  (prev, next) => prev.item === next.item && prev.renderedText === next.renderedText,
);

// ---------------------------------------------------------------------------
// Live region — streaming assistant text + running tools + spinner
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Tail-clamp streamed assistant text to the last N lines with a `… ` prefix
 * when truncation occurred. The full text still lands in the transcript via
 * `assistant-end`; this clamp only protects the live preview from pushing the
 * bottom-pinned zones off-screen during long replies.
 */
export function tailClampAssistant(text: string, maxLines: number): {
  text: string;
  truncated: boolean;
} {
  if (!text) return { text, truncated: false };
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false };
  const kept = lines.slice(-maxLines).join("\n");
  return { text: `…\n${kept}`, truncated: true };
}

const SpinnerInner = ({ label }: { label: string }): React.ReactElement => {
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
    <Box paddingX={2} paddingY={1} justifyContent="space-between" width="100%">
      <Box gap={1}>
        <Text color={tiffany.secondary} bold>
          {SPINNER_FRAMES[frame]}
        </Text>
        <Text color={tiffany.comment}>{`${label} (${secs}s)`}</Text>
      </Box>
      <Text color={tiffany.comment}>ctrl+c to cancel</Text>
    </Box>
  );
};

// Spinner has its own 80 ms tick — memozing the export means only the Spinner
// subtree re-renders on tick; parent LiveRegion does not re-render.
export const Spinner = memo(SpinnerInner);

/** Max lines of streamed text shown in the live preview before clamping. */
const LIVE_ASSISTANT_MAX_LINES = 3;

const LiveRegionInner = ({
  assistant,
  tools,
  busy,
  busyLabel,
}: {
  assistant: string;
  tools: RunningTool[];
  busy: boolean;
  busyLabel: string | null;
}): React.ReactElement | null => {
  if (!busy && !assistant && tools.length === 0) return null;
  const { text: visibleAssistant } = tailClampAssistant(assistant, LIVE_ASSISTANT_MAX_LINES);
  return (
    <Box flexDirection="column" width="100%">
      {tools.map((t) => (
        <Box key={t.id} paddingX={2} gap={1}>
          <Text color={tiffany.secondary}>{"⚙"}</Text>
          <Text bold color={tiffany.fg}>
            {t.label}
          </Text>
        </Box>
      ))}
      {assistant ? (
        <Box flexDirection="column" width="100%" paddingX={2} marginBottom={1}>
          <Box gap={1} marginBottom={1}>
            <Text color={tiffany.secondary} bold>
              {"✦ Assistant"}
            </Text>
          </Box>
          <Text color={tiffany.fg}>{markdownToAnsi(visibleAssistant)}</Text>
        </Box>
      ) : null}
      {busy ? (
        <Spinner
          label={
            busyLabel ?? (assistant ? "Writing…" : tools.length > 0 ? "Working…" : "Thinking…")
          }
        />
      ) : null}
    </Box>
  );
};

export const LiveRegion = memo(
  LiveRegionInner,
  (prev, next) =>
    prev.assistant === next.assistant &&
    prev.busy === next.busy &&
    prev.busyLabel === next.busyLabel &&
    prev.tools === next.tools,
);

// ---------------------------------------------------------------------------
// InputBar — OpenCode-style bordered input box with model badge
// ---------------------------------------------------------------------------

const InputBarInner = ({
  value,
  cursor,
  model,
  mode: _mode,
  disabled,
}: {
  value: string;
  cursor: number;
  model: string;
  mode: string;
  disabled: boolean;
}): React.ReactElement => {
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || " ";
  const after = value.slice(cursor + 1);

  const showPlaceholder = value.length === 0;
  const borderTokens = disabled ? tokens.borders.inputIdle : tokens.borders.inputActive;

  return (
    <Box flexDirection="column" width="100%" paddingX={2} marginTop={1}>
      {/* Clean input card container */}
      <Box
        {...borderTokens}
        backgroundColor={layout.inputBox.bg}
        paddingX={2}
        paddingY={0}
        width="100%"
      >
        <Text color={disabled ? tiffany.comment : tiffany.primary} bold>
          {"✦ "}
        </Text>
        {showPlaceholder && !disabled ? (
          <Text color={layout.inputBox.placeholder}>
            Message Tarantul or type / for commands...
          </Text>
        ) : (
          <>
            <Text color={tiffany.fg}>{before}</Text>
            <Text inverse>{at}</Text>
            <Text color={tiffany.fg}>{after}</Text>
          </>
        )}
      </Box>

      {/* Row below card: Hints (Left) + Model (Right) */}
      <Box justifyContent="space-between" width="100%" marginTop={1} paddingX={1}>
        <Box gap={2}>
          <Text color={tiffany.comment}>
            <Text bold color={tiffany.secondary}>
              ↑↓
            </Text>{" "}
            history
          </Text>
          <Text color={tiffany.comment}>
            <Text bold color={tiffany.secondary}>
              tab
            </Text>{" "}
            autocomplete
          </Text>
          <Text color={tiffany.comment}>
            <Text bold color={tiffany.secondary}>
              /
            </Text>{" "}
            commands
          </Text>
        </Box>

        {/* Model info on the right */}
        <Box>
          <Text color={tiffany.comment}>{`🤖 ${model}`}</Text>
        </Box>
      </Box>
    </Box>
  );
};

export const InputBar = memo(
  InputBarInner,
  (prev, next) =>
    prev.value === next.value &&
    prev.cursor === next.cursor &&
    prev.model === next.model &&
    prev.mode === next.mode &&
    prev.disabled === next.disabled,
);

// ---------------------------------------------------------------------------
// SelectPrompt — Arrow-key selector overlay (permissions, session picker)
// ---------------------------------------------------------------------------

const SelectPromptInner = ({
  spec,
  selectedIndex,
}: {
  spec: SelectorSpec;
  selectedIndex: number;
}): React.ReactElement => {
  const accent = spec.accent === "warn" ? tiffany.orange : tiffany.primary;
  const hint = spec.hint ?? "↑↓ select · enter confirm · esc cancel";
  return (
    <Box flexDirection="column" width="100%" paddingX={2} marginBottom={1}>
      <Box
        flexDirection="column"
        width="100%"
        borderStyle="round"
        borderColor={accent}
        paddingX={2}
        paddingY={1}
      >
        <Text color={accent} bold>
          {spec.title}
        </Text>
        {(spec.body ?? []).map((line) => (
          <Text key={line} color={tiffany.comment}>
            {line}
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          {spec.options.map((opt, i) => {
            const selected = i === selectedIndex;
            return (
              <Box key={`${opt.label}-${i}`} gap={1}>
                <Text color={tiffany.green}>{selected ? "[x]" : "[ ]"}</Text>
                <Text color={selected ? tiffany.fg : tiffany.comment} bold={selected}>
                  {opt.label}
                </Text>
                {opt.detail ? <Text color={tiffany.comment}>{opt.detail}</Text> : null}
              </Box>
            );
          })}
        </Box>
        <Text color={tiffany.comment}>{hint}</Text>
      </Box>
    </Box>
  );
};

export const SelectPrompt = memo(
  SelectPromptInner,
  (prev, next) => prev.spec === next.spec && prev.selectedIndex === next.selectedIndex,
);

// ---------------------------------------------------------------------------
// SuggestionList — Slash-command autocomplete dropdown
// ---------------------------------------------------------------------------

const SuggestionListInner = ({
  items,
  selectedIndex,
}: {
  items: readonly SlashCommand[];
  selectedIndex: number;
}): React.ReactElement => {
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
        <Text color={tiffany.comment}>{"↑↓ select · tab complete · enter run · esc dismiss"}</Text>
      </Box>
    </Box>
  );
};

export const SuggestionList = memo(
  SuggestionListInner,
  (prev, next) => prev.items === next.items && prev.selectedIndex === next.selectedIndex,
);

export { toolCallLabel };
