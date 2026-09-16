export type SaveStatus = 'saved' | 'saving' | 'error';

/**
 * `soon` debounces structural changes but never postpones a save beyond `maxWaitMs` from the first pending change.
 * `idle` is for low-value churn such as page titles: it never postpones an already scheduled save.
 */
export type SaveUrgency = 'soon' | 'idle';

export interface SaveSchedulerOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  idleDelayMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  onError?: (error: unknown) => void;
}

export class SaveScheduler {
  readonly #save: () => Promise<unknown>;
  readonly #onStatus: (status: SaveStatus) => void;
  readonly #onError: (error: unknown) => void;
  readonly #debounceMs: number;
  readonly #maxWaitMs: number;
  readonly #idleDelayMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  #timer: NodeJS.Timeout | null = null;
  #deadline = Number.POSITIVE_INFINITY;
  #firstPendingAt: number | null = null;
  #dirty = false;
  #inFlight: Promise<boolean> | null = null;
  #retryDelayMs = 0;
  #disposed = false;

  constructor(save: () => Promise<unknown>, onStatus: (status: SaveStatus) => void, options: SaveSchedulerOptions = {}) {
    this.#save = save;
    this.#onStatus = onStatus;
    this.#onError = options.onError ?? (() => undefined);
    this.#debounceMs = options.debounceMs ?? 450;
    this.#maxWaitMs = options.maxWaitMs ?? 2000;
    this.#idleDelayMs = options.idleDelayMs ?? 5000;
    this.#retryBaseMs = options.retryBaseMs ?? 1000;
    this.#retryMaxMs = options.retryMaxMs ?? 30_000;
  }

  get isDirty(): boolean {
    return this.#dirty;
  }

  schedule(urgency: SaveUrgency = 'soon'): void {
    if (this.#disposed) return;
    const now = Date.now();
    this.#dirty = true;
    this.#firstPendingAt ??= now;
    if (urgency === 'idle') {
      const target = now + this.#idleDelayMs;
      if (!this.#timer || target < this.#deadline) this.#arm(target);
      return;
    }
    this.#arm(Math.max(now, Math.min(now + this.#debounceMs, this.#firstPendingAt + this.#maxWaitMs)));
  }

  /** Writes every pending change, waiting for an in-flight save first. Rejects if the final write fails. */
  async flush(): Promise<void> {
    this.#clearTimer();
    for (;;) {
      if (this.#inFlight) {
        await this.#inFlight;
        continue;
      }
      if (!this.#dirty) return;
      await this.#runSave();
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
  }

  #arm(deadline: number): void {
    this.#clearTimer();
    this.#deadline = deadline;
    this.#timer = setTimeout(() => this.#onTimer(), Math.max(0, deadline - Date.now()));
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#deadline = Number.POSITIVE_INFINITY;
  }

  #onTimer(): void {
    this.#timer = null;
    this.#deadline = Number.POSITIVE_INFINITY;
    if (this.#disposed) return;
    if (this.#inFlight) {
      void this.#inFlight.then(() => {
        if (this.#dirty && !this.#timer && !this.#disposed) this.#arm(Date.now());
      });
      return;
    }
    if (!this.#dirty) return;
    // Timer-driven failures are reported through status and onError and retried with backoff; nothing is left unhandled.
    this.#runSave().catch((error: unknown) => this.#onError(error));
  }

  async #runSave(): Promise<void> {
    this.#dirty = false;
    this.#firstPendingAt = null;
    this.#onStatus('saving');
    // Promise.resolve().then turns a synchronous throw from the save callback into a handled rejection.
    const attempt = Promise.resolve().then(() => this.#save());
    this.#inFlight = attempt.then(() => true, () => false);
    try {
      await attempt;
      this.#retryDelayMs = 0;
      this.#onStatus('saved');
    } catch (error) {
      this.#dirty = true;
      this.#onStatus('error');
      if (!this.#disposed) {
        this.#retryDelayMs = Math.min(this.#retryMaxMs, this.#retryDelayMs === 0 ? this.#retryBaseMs : this.#retryDelayMs * 2);
        this.#firstPendingAt = Date.now();
        this.#arm(Date.now() + this.#retryDelayMs);
      }
      throw error;
    } finally {
      this.#inFlight = null;
    }
  }
}
