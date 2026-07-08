/**
 * Markdown chunking for the memory index.
 *
 * Splits a file into overlapping, line-aligned chunks (~400 tokens each with
 * ~80 tokens of overlap — a solid default for markdown retrieval). Line
 * alignment lets search results cite exact line ranges and lets `memory_get`
 * re-read them.
 *
 * Token counts are the same cheap chars/4 estimate used elsewhere in the agent
 * core — good enough for sizing chunks, and it avoids a tokenizer dependency.
 */

export interface Chunk {
  /** 1-based inclusive start line in the source file. */
  startLine: number;
  /** 1-based inclusive end line in the source file. */
  endLine: number;
  text: string;
}

export interface ChunkOptions {
  /** Target chunk size in estimated tokens. */
  maxTokens?: number;
  /** Overlap between consecutive chunks in estimated tokens. */
  overlapTokens?: number;
}

const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 80;

/** Cheap token estimate (~4 chars/token). Matches the agent core's heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Chunk markdown into overlapping line-aligned windows. Returns `[]` for blank
 * input. Guarantees forward progress even when a single line exceeds the token
 * budget (that line becomes its own oversized chunk).
 */
export function chunkMarkdown(text: string, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = Math.max(1, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  const overlapTokens = Math.max(
    0,
    Math.min(opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS, maxTokens - 1),
  );

  if (!text.trim()) return [];

  const lines = text.split("\n");
  const lineTokens = lines.map((l) => Math.max(1, estimateTokens(l)));
  const chunks: Chunk[] = [];

  let start = 0;
  while (start < lines.length) {
    let end = start; // exclusive
    let tokens = 0;
    while (end < lines.length && (end === start || tokens + lineTokens[end]! <= maxTokens)) {
      tokens += lineTokens[end]!;
      end++;
    }

    const slice = lines.slice(start, end);
    if (slice.join("").trim()) {
      chunks.push({
        startLine: start + 1,
        endLine: end,
        text: slice.join("\n"),
      });
    }

    if (end >= lines.length) break;

    // Step the window forward, retaining ~overlapTokens of trailing context.
    let overlap = 0;
    let nextStart = end;
    while (nextStart > start + 1 && overlap + lineTokens[nextStart - 1]! <= overlapTokens) {
      nextStart--;
      overlap += lineTokens[nextStart]!;
    }
    start = nextStart; // strictly greater than previous start (end > start+... )
  }

  return chunks;
}
