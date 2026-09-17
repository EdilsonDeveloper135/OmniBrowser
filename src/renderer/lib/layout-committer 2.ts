import type { LayoutBatch } from '../../shared/schemas';

type FrameScheduler = (callback: () => void) => number;
type FrameCanceller = (handle: number) => void;

/**
 * Sends native-view layout to the main process at most once per animation frame and never with more than one request in
 * flight. Intermediate layouts are dropped in favour of the newest one, and identical layouts are not sent again.
 */
export class LayoutCommitter {
  readonly #send: (batch: LayoutBatch) => Promise<void>;
  readonly #onError: (error: unknown) => void;
  readonly #requestFrame: FrameScheduler;
  readonly #cancelFrame: FrameCanceller;
  #pending: { batch: LayoutBatch; key: string } | null = null;
  #lastSentKey: string | null = null;
  #frame: number | null = null;
  #inFlight = false;
  #disposed = false;

  constructor(
    send: (batch: LayoutBatch) => Promise<void>,
    onError: (error: unknown) => void,
    requestFrame: FrameScheduler = (callback) => window.requestAnimationFrame(callback),
    cancelFrame: FrameCanceller = (handle) => window.cancelAnimationFrame(handle)
  ) {
    this.#send = send;
    this.#onError = onError;
    this.#requestFrame = requestFrame;
    this.#cancelFrame = cancelFrame;
  }

  submit(batch: LayoutBatch): void {
    if (this.#disposed) return;
    const key = JSON.stringify(batch);
    if (key === (this.#pending?.key ?? this.#lastSentKey)) return;
    this.#pending = { batch, key };
    this.#scheduleFlush();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#frame !== null) this.#cancelFrame(this.#frame);
    this.#frame = null;
    this.#pending = null;
  }

  #scheduleFlush(): void {
    if (this.#frame !== null || this.#inFlight) return;
    this.#frame = this.#requestFrame(() => this.#flush());
  }

  #flush(): void {
    this.#frame = null;
    const next = this.#pending;
    if (!next || this.#inFlight || this.#disposed) return;
    this.#pending = null;
    if (next.key === this.#lastSentKey) return;
    this.#inFlight = true;
    this.#lastSentKey = next.key;
    this.#send(next.batch).catch((error: unknown) => {
      // Let the next submission retry the same layout instead of treating it as already applied.
      this.#lastSentKey = null;
      this.#onError(error);
    }).finally(() => {
      this.#inFlight = false;
      if (this.#pending) this.#scheduleFlush();
    });
  }
}
