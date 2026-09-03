/**
 * Microbenchmark for the TUI reducer pipeline.
 *
 * Runs synthetic load against the pure parts of the TUI (no React rendering —
 * that would require ink-testing-library which we don't ship) and prints
 * wall-clock timings. Invoke with `bun run bench/tui.bench.ts`.
 */

import {
  applyUiEvent,
  initialLiveSlice,
  initialTranscriptSlice,
  type LiveSlice,
  type TranscriptSlice,
} from "../src/cli/ink/state.ts";
import type { UiEvent } from "../src/cli/ink/types.ts";
import { visibleRange } from "../src/cli/ink/WindowedList.tsx";

const STREAM_ITEMS = 1000;
const ASSISTANT_LEN = 4096;

function bench(name: string, iter: () => void): number {
  // Warm up.
  for (let i = 0; i < 3; i++) iter();
  const start = performance.now();
  iter();
  const elapsed = performance.now() - start;
  console.log(`  ${name.padEnd(40)} ${elapsed.toFixed(3)} ms`);
  return elapsed;
}

function synthTranscript(n: number): TranscriptSlice {
  const items = [];
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      items.push({ id: i + 1, kind: "user", text: `q ${i}` });
    } else {
      items.push({
        id: i + 1,
        kind: "assistant",
        text: `a ${i}`,
        model: "bench",
        time: "00:00",
      });
    }
  }
  return initialTranscriptSlice(n + 1, items);
}

function benchStreaming(): void {
  console.log("Streaming 1,000 deltas into a 1-turn transcript:");
  let t = synthTranscript(0);
  let l: LiveSlice = initialLiveSlice;

  bench("1,000 deltas (4 KB total payload)", () => {
    for (let i = 0; i < STREAM_ITEMS; i++) {
      const chunk = "x".repeat(ASSISTANT_LEN / STREAM_ITEMS);
      const e: UiEvent = { t: "assistant-delta", text: chunk };
      const out = applyUiEvent(t, l, e);
      t = out.transcript;
      l = out.live;
    }
  });
}

function benchVisibleRange(): void {
  console.log("WindowedList.visibleRange over 5,000 items × 1,000 scroll positions:");
  const N = 5000;
  const heights = new Array<number>(N).fill(3);
  const offsets: number[] = new Array<number>(N);
  let acc = 0;
  for (let i = 0; i < N; i++) {
    offsets[i] = acc;
    acc += 3;
  }
  let first = 0;
  let last = 0;
  bench("1,000 visibleRange() calls", () => {
    for (let s = 0; s < 1000; s++) {
      const off = (s * 7) % Math.max(1, acc - 20);
      const out = visibleRange(offsets, heights, off, 20);
      first = out.first;
      last = out.last;
    }
  });
  console.log(`    (last first=${first} last=${last})`);
}

function benchTranscript(): void {
  console.log("Transcript reducer: 500 push events:");
  bench("500 assistant-end events on an empty transcript", () => {
    let t = synthTranscript(0);
    let l: LiveSlice = initialLiveSlice;
    for (let i = 0; i < 500; i++) {
      ({ live: l } = applyUiEvent(t, l, { t: "assistant-delta", text: "Hello " }));
      ({ transcript: t, live: l } = applyUiEvent(t, l, { t: "assistant-end", model: "m" }));
    }
  });
}

console.log("TUI microbenchmark (no rendering — pure reducer + math)\n");
benchStreaming();
benchVisibleRange();
benchTranscript();
console.log("\nDone. For end-to-end rendering benchmarks, run `bun run start agent` and watch CPU.");