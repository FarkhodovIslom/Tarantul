/**
 * Async message queue for decoupled channel↔agent communication.
 * Mirrors nanobot/bus/queue.py
 *
 * RAM notes:
 * - Uses a single linked-list-style async queue per direction (no pre-allocation).
 * - Waiters are stored as Promise resolve callbacks — no extra wrapper objects.
 * - Messages are held by reference; no copying.
 */

import type { InboundMessage, OutboundMessage } from "./events.js";

// ---------------------------------------------------------------------------
// Generic async FIFO queue
// ---------------------------------------------------------------------------

class AsyncQueue<T> {
  /** Buffered items not yet consumed. */
  private readonly buf: T[] = [];
  /** Resolve callbacks waiting for the next item. */
  private readonly waiters: Array<(item: T) => void> = [];

  /** Enqueue an item. If a waiter exists, resolve it immediately. */
  put(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.buf.push(item);
    }
  }

  /** Dequeue the next item, awaiting if the queue is empty. */
  get(): Promise<T> {
    const item = this.buf.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => this.waiters.push(resolve));
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

  /** Block until the next inbound message is available. */
  consumeInbound(): Promise<InboundMessage> {
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

  /** Block until the next outbound message is available. */
  consumeOutbound(): Promise<OutboundMessage> {
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
}
