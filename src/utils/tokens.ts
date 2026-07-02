
import { getEncoding, type Tiktoken } from "js-tiktoken";

// ---------------------------------------------------------------------------
// Encoder singleton — initialized once, reused forever
// ---------------------------------------------------------------------------

let _enc: Tiktoken | null = null;

function getEncoder(): Tiktoken | null {
  if (_enc) return _enc;
  try {
    _enc = getEncoding("cl100k_base");
    return _enc;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-message token estimate cache (WeakMap = no manual cleanup needed)
// ---------------------------------------------------------------------------

const _msgCache = new WeakMap<object, number>();

/** Estimate tokens for a single message object. Result is cached in WeakMap. */
export function estimateMessageTokens(msg: Record<string, unknown>): number {
  const cached = _msgCache.get(msg);
  if (cached !== undefined) return cached;

  const tokens = _computeMessageTokens(msg);
  _msgCache.set(msg, tokens);
  return tokens;
}

function _computeMessageTokens(msg: Record<string, unknown>): number {
  const parts: string[] = [];

  // content
  const content = msg["content"];
  if (typeof content === "string") {
    if (content) parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "object" && part !== null) {
        const p = part as Record<string, unknown>;
        if (p["type"] === "text" && typeof p["text"] === "string") {
          parts.push(p["text"]);
        } else {
          // image or other block — use JSON size as proxy
          parts.push(JSON.stringify(part));
        }
      }
    }
  } else if (content != null) {
    parts.push(JSON.stringify(content));
  }

  // tool_calls
  const tc = msg["tool_calls"];
  if (tc) parts.push(JSON.stringify(tc));

  // reasoning_content
  const rc = msg["reasoning_content"];
  if (typeof rc === "string" && rc) parts.push(rc);

  // name, tool_call_id
  for (const key of ["name", "tool_call_id"]) {
    const v = msg[key];
    if (typeof v === "string" && v) parts.push(v);
  }

  if (parts.length === 0) return 4;

  const payload = parts.join("\n");
  const enc = getEncoder();
  try {
    return Math.max(4, (enc ? enc.encode(payload).length : Math.ceil(payload.length / 4)) + 4);
  } catch {
    return Math.max(4, Math.ceil(payload.length / 4) + 4);
  }
}

/**
 * Invalidate the cached token count for a message.
 * Call this when a message's content is mutated in place.
 */
export function invalidateTokenCache(msg: Record<string, unknown>): void {
  _msgCache.delete(msg);
}

/** Estimate tokens for a list of messages + optional tool definitions. */
export function estimatePromptTokens(
  messages: Record<string, unknown>[],
  tools?: Record<string, unknown>[] | null,
): number {
  let total = messages.length * 4; // per-message framing overhead
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  if (tools?.length) {
    const toolsJson = JSON.stringify(tools);
    const enc = getEncoder();
    try {
      total += enc ? enc.encode(toolsJson).length : Math.ceil(toolsJson.length / 4);
    } catch {
      total += Math.ceil(toolsJson.length / 4);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Incremental token tracker
// ---------------------------------------------------------------------------

/**
 * Maintains a running token count as messages are added/removed.
 * Avoids full recount on every iteration — O(1) per append/drop.
 */
export class TokenTracker {
  private total = 0;
  // Parallel array: tokenCounts[i] = tokens for messages[i]
  private readonly tokenCounts: number[] = [];

  /** Add a message and track its tokens. */
  push(msg: Record<string, unknown>): void {
    const t = estimateMessageTokens(msg);
    this.tokenCounts.push(t);
    this.total += t;
  }

  /** Remove the oldest N messages and subtract their tokens. */
  dropFirst(n: number): void {
    if (n <= 0) return;
    const dropped = this.tokenCounts.splice(0, n);
    for (const t of dropped) this.total -= t;
  }

  /** Update token count for a message at index i (after in-place mutation). */
  update(i: number, msg: Record<string, unknown>): void {
    const old = this.tokenCounts[i] ?? 0;
    invalidateTokenCache(msg);
    const fresh = estimateMessageTokens(msg);
    this.tokenCounts[i] = fresh;
    this.total += fresh - old;
  }

  get totalTokens(): number {
    return this.total;
  }

  /** Running token sum for messages[startIdx..endIdx). */
  sumRange(startIdx: number, endIdx: number): number {
    let s = 0;
    for (let i = startIdx; i < endIdx && i < this.tokenCounts.length; i++) {
      s += this.tokenCounts[i] ?? 0;
    }
    return s;
  }

  get length(): number {
    return this.tokenCounts.length;
  }
}
