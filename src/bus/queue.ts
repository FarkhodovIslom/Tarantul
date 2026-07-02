import type { InboundMessage, OutboundMessage } from "./events.js";

// ---------------------------------------------------------------------------
// Generic async FIFO queue
// ---------------------------------------------------------------------------

class AsyncQueue<T> {
  /** Buffered items not yet consumed. */
  private readonly buf: T[] = [];
  /** Resolve callbacks waiting for the next item. */
  private readonly waiters: Array<(item: T | undefined) => void> = [];
  /** Once closed, waiters are released with undefined and no new items accepted. */
  private closed = false;

  /** Enqueue an item. If a waiter exists, resolve it immediately. */
  put(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.buf.push(item);
    }
  }

  /**
   * Dequeue the next item, awaiting if the queue is empty.
   * Resolves to `undefined` only when the queue is closed — callers use that
   * as a shutdown signal. A single awaiter is registered per call, so no
   * abandoned waiters accumulate (unlike a poll/timeout race).
   */
  get(): Promise<T | undefined> {
    const item = this.buf.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise<T | undefined>((resolve) => this.waiters.push(resolve));
  }

  /** Non-blocking: returns undefined when queue is empty. */
  tryGet(): T | undefined {
    return this.buf.shift();
  }

  get size(): number {
    return this.buf.length;
  }

  /** Drain and return all buffered items without blocking. */
  drain(): T[] {
    return this.buf.splice(0);
  }

  /** Release all pending waiters with `undefined` and reject further items. */
  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!(undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// MessageBus
// ---------------------------------------------------------------------------

export class MessageBus {
  private readonly _inbound = new AsyncQueue<InboundMessage>();
  private readonly _outbound = new AsyncQueue<OutboundMessage>();

  /** Push a message from a channel into the agent. */
  async publishInbound(msg: InboundMessage): Promise<void> {
    this._inbound.put(msg);
  }

  /** Block until the next inbound message is available (undefined when closed). */
  consumeInbound(): Promise<InboundMessage | undefined> {
    return this._inbound.get();
  }

  /** Non-blocking inbound dequeue. Returns undefined if empty. */
  tryConsumeInbound(): InboundMessage | undefined {
    return this._inbound.tryGet();
  }

  /** Push a response from the agent to a channel. */
  async publishOutbound(msg: OutboundMessage): Promise<void> {
    this._outbound.put(msg);
  }

  /** Block until the next outbound message is available (undefined when closed). */
  consumeOutbound(): Promise<OutboundMessage | undefined> {
    return this._outbound.get();
  }

  /** Non-blocking outbound dequeue. Returns undefined if empty. */
  tryConsumeOutbound(): OutboundMessage | undefined {
    return this._outbound.tryGet();
  }

  /** Drain all pending outbound messages at once. */
  drainOutbound(): OutboundMessage[] {
    return this._outbound.drain();
  }

  get inboundSize(): number {
    return this._inbound.size;
  }

  get outboundSize(): number {
    return this._outbound.size;
  }

  /** Wake the inbound consumer (gateway loop) for shutdown. */
  closeInbound(): void {
    this._inbound.close();
  }

  /** Wake the outbound consumer (channel dispatch loop) for shutdown. */
  closeOutbound(): void {
    this._outbound.close();
  }

  /** Close both directions. */
  close(): void {
    this._inbound.close();
    this._outbound.close();
  }
}
