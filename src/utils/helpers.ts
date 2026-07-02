const _UNSAFE_CHARS = /[^\w\-. ]/g;

/** Replace unsafe filesystem characters with underscores. */
export function safeFilename(name: string): string {
  return name.replace(_UNSAFE_CHARS, "_").trim();
}

/** Truncate text with a stable suffix marker. */
export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n... (truncated)";
}

/**
 * Find the first index in a message list where all preceding tool results
 * have a matching assistant tool-call declaration.
 * Used to avoid persisting orphan tool results that would break the model.
 */
export function findLegalMessageStart(messages: Record<string, unknown>[]): number {
  const declared = new Set<string>();
  let start = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const role = msg["role"] as string | undefined;

    if (role === "assistant") {
      const toolCalls = msg["tool_calls"];
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (typeof tc === "object" && tc !== null) {
            const id = (tc as Record<string, unknown>)["id"];
            if (id) declared.add(String(id));
          }
        }
      }
    } else if (role === "tool") {
      const tid = msg["tool_call_id"] as string | undefined;
      if (tid && !declared.has(tid)) {
        start = i + 1;
        declared.clear();
        // Re-scan from new start up to (but not including) i+1
        for (let j = start; j <= i; j++) {
          const prev = messages[j]!;
          if (prev["role"] === "assistant") {
            const tcs = prev["tool_calls"];
            if (Array.isArray(tcs)) {
              for (const tc of tcs) {
                if (typeof tc === "object" && tc !== null) {
                  const pid = (tc as Record<string, unknown>)["id"];
                  if (pid) declared.add(String(pid));
                }
              }
            }
          }
        }
      }
    }
  }

  return start;
}
