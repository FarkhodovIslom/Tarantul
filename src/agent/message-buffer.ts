import { TokenTracker, estimateMessageTokens } from "../utils/tokens.js";
import { logger } from "../utils/logger.js";

const SNIP_SAFETY_BUFFER = 1024;
const MIN_KEPT_MESSAGES = 4;

export type Message = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helper: find the first index where all tool results have matching assistant
// calls (ensures we never send orphaned tool messages to the provider).
// ---------------------------------------------------------------------------
function findLegalStart(messages: Message[], fromIdx: number): number {
  const declared = new Set<string>();
  let legalStart = fromIdx;

  for (let i = fromIdx; i < messages.length; i++) {
    const msg = messages[i]!;
    const role = msg["role"] as string | undefined;

    if (role === "assistant") {
      const tcs = msg["tool_calls"] as Message[] | undefined;
      if (tcs) {
        for (const tc of tcs) {
          const id = tc["id"];
          if (typeof id === "string") declared.add(id);
        }
      }
    } else if (role === "tool") {
      const tid = msg["tool_call_id"];
      if (typeof tid === "string" && !declared.has(tid)) {
        legalStart = i + 1;
        declared.clear();
        // Re-scan backwards from new legalStart for declared IDs
        for (let j = legalStart; j <= i; j++) {
          const m = messages[j]!;
          if (m["role"] === "assistant") {
            const tcs = m["tool_calls"] as Message[] | undefined;
            if (tcs) {
              for (const tc of tcs) {
                const id = tc["id"];
                if (typeof id === "string") declared.add(id);
              }
            }
          }
        }
      }
    }
  }
  return legalStart;
}

// ---------------------------------------------------------------------------
// MessageBuffer
// ---------------------------------------------------------------------------

export class MessageBuffer {
  /** All messages ever appended (never shrinks — old ones just become invisible). */
  private readonly msgs: Message[] = [];

  /** Incremental token tracker — parallel to msgs[]. */
  private readonly tracker = new TokenTracker();

  /**
   * The first index considered "in window" by the last snip operation.
   * Indices [0, windowStart) are still in memory but not sent to the provider.
   */
  private windowStart = 0;

  /**
   * Index of the last system message (always kept regardless of window).
   * -1 if none.
   */
  private systemMsgIndex = -1;

  // ---------------------------------------------------------------------------
  // Append
  // ---------------------------------------------------------------------------

  append(msg: Message): void {
    if (msg["role"] === "system" && this.systemMsgIndex === -1) {
      this.systemMsgIndex = this.msgs.length;
    }
    this.msgs.push(msg);
    this.tracker.push(msg);
  }

  appendAll(msgs: Message[]): void {
    for (const m of msgs) this.append(m);
  }

  // ---------------------------------------------------------------------------
  // In-place tool result budget enforcement
  // ---------------------------------------------------------------------------

  /**
   * Truncate oversized tool result content directly in the slot.
   * Returns true if any slot was modified (for dirty tracking).
   */
  applyToolResultBudget(maxChars: number): boolean {
    let modified = false;
    for (let i = this.windowStart; i < this.msgs.length; i++) {
      const msg = this.msgs[i]!;
      if (msg["role"] !== "tool") continue;

      const content = msg["content"];
      if (typeof content === "string" && content.length > maxChars) {
        msg["content"] = content.slice(0, maxChars) + "\n... (truncated)";
        this.tracker.update(i, msg);
        modified = true;
      }
    }
    return modified;
  }

  // ---------------------------------------------------------------------------
  // Zero-copy context windowing
  // ---------------------------------------------------------------------------

  /**
   * Advance windowStart so total tokens of [windowStart..end] fit within budget.
   * System message is always included (prepended separately).
   * Returns the new windowStart.
   *
   * Zero allocations — only arithmetic on indices.
   */
  snipToFit(budget: number, toolTokens: number): void {
    const totalBudget = budget - toolTokens;
    if (totalBudget <= 0) return;

    // System message tokens are always consumed
    const sysTokens = this.systemMsgIndex >= 0
      ? estimateMessageTokens(this.msgs[this.systemMsgIndex]!)
      : 0;
    const nonSysBudget = Math.max(128, totalBudget - sysTokens);

    // Count from the end backwards — keep as many recent messages as possible
    let kept = 0;
    let keptTokens = 0;
    const end = this.msgs.length;

    for (let i = end - 1; i >= 0; i--) {
      if (i === this.systemMsgIndex) continue;
      const t = this.tracker.sumRange(i, i + 1);
      if (kept > 0 && keptTokens + t > nonSysBudget) break;
      keptTokens += t;
      kept++;
    }

    const newStart = Math.max(0, end - kept);
    if (newStart <= this.windowStart) return; // already tight or no change

    // Ensure we start at a legal boundary (no orphaned tool results)
    let legalStart = findLegalStart(this.msgs, newStart);

    // Fallback: keep last MIN_KEPT_MESSAGES if nothing is legal
    if (legalStart >= end) {
      legalStart = Math.max(0, end - MIN_KEPT_MESSAGES);
      legalStart = findLegalStart(this.msgs, legalStart);
    }

    if (legalStart > this.windowStart) {
      this.windowStart = legalStart;
    }
  }

  // ---------------------------------------------------------------------------
  // Provider view — the only place a shallow copy is made
  // ---------------------------------------------------------------------------

  /**
   * Returns a shallow copy of message references for the LLM call.
   * If a system message exists, it is always prepended regardless of window.
   *
   * This is the ONLY place we allocate a new array per LLM call.
   * All elements are references — no message objects are cloned.
   */
  toProviderView(): Message[] {
    const hasSys = this.systemMsgIndex >= 0;
    const sysMsg = hasSys ? this.msgs[this.systemMsgIndex]! : null;

    // Non-system messages from windowStart onward
    const view: Message[] = [];
    if (sysMsg) view.push(sysMsg);

    for (let i = this.windowStart; i < this.msgs.length; i++) {
      if (i === this.systemMsgIndex) continue;
      view.push(this.msgs[i]!);
    }
    return view;
  }

  /**
   * Same as toProviderView but appends one extra message at the end
   * without mutating the buffer (used for finalization retry).
   */
  toProviderViewWith(extra: Message): Message[] {
    const view = this.toProviderView();
    view.push(extra);
    return view;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get length(): number {
    return this.msgs.length;
  }

  get windowLength(): number {
    return this.msgs.length - this.windowStart;
  }

  /**
   * Token estimate for the current window only — matches what would actually
   * be sent to the provider (window range + system message if it's outside
   * the window). `tracker.totalTokens` is the all-time running total and
   * never shrinks when windowStart advances (dropFirst() is intentionally
   * never called: messages before windowStart stay in `msgs` for session
   * persistence, so splicing the tracker's parallel array would desync its
   * indices from `msgs`). Reuses the same estimate `enforceContextBudget()`
   * uses to decide when to snip, so the two stay consistent.
   */
  get totalTokens(): number {
    return estimateCurrentTokens(this.msgs, this.windowStart, this.systemMsgIndex);
  }

  /** Last message appended (or undefined). */
  get last(): Message | undefined {
    return this.msgs[this.msgs.length - 1];
  }

  /** All messages (not just windowed). Used for session persistence. */
  allMessages(): readonly Message[] {
    return this.msgs;
  }

  /**
   * Check budget and advance window if needed.
   * Returns true if windowing was performed.
   */
  enforceContextBudget(
    contextWindowTokens: number,
    maxOutputTokens: number,
    toolTokens: number,
  ): boolean {
    const budget = contextWindowTokens - maxOutputTokens - SNIP_SAFETY_BUFFER;
    if (budget <= 0) return false;

    const current = estimateCurrentTokens(this.msgs, this.windowStart, this.systemMsgIndex);
    if (current + toolTokens <= budget) return false;

    const before = this.windowStart;
    this.snipToFit(budget, toolTokens);
    if (this.windowStart > before) {
      logger.debug(`Context window: dropped ${this.windowStart - before} messages`);
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helper: fast token estimate of current window
// ---------------------------------------------------------------------------

function estimateCurrentTokens(
  msgs: Message[],
  windowStart: number,
  sysIdx: number,
): number {
  let total = 0;
  for (let i = windowStart; i < msgs.length; i++) {
    total += estimateMessageTokens(msgs[i]!);
  }
  // Add system message tokens if it's outside window
  if (sysIdx >= 0 && sysIdx < windowStart) {
    total += estimateMessageTokens(msgs[sysIdx]!);
  }
  return total;
}
