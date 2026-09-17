import type { OmniEvent } from '../../shared/contracts';

export type ShellNotice = Omit<Extract<OmniEvent, { type: 'notice' }>, 'type'>;

interface ShellNoticesOptions {
  now?: () => number;
  deduplicationMs?: number;
  maxPending?: number;
}

/**
 * Notices for the shell. Identical notices (for example repeated permission requests from one page) are shown at most
 * once per window. Notices raised while no shell document is subscribed — a recovered workspace, or a restored page that
 * fails to load while the shell is still starting — are held and handed over when the shell bootstraps, instead of being
 * sent to a page that is not listening yet.
 */
export class ShellNotices {
  readonly #deliver: (notice: ShellNotice) => void;
  readonly #now: () => number;
  readonly #deduplicationMs: number;
  readonly #maxPending: number;
  readonly #recent = new Map<string, number>();
  #pending: ShellNotice[] = [];
  #subscribed = false;

  constructor(deliver: (notice: ShellNotice) => void, options: ShellNoticesOptions = {}) {
    this.#deliver = deliver;
    this.#now = options.now ?? Date.now;
    this.#deduplicationMs = options.deduplicationMs ?? 4000;
    this.#maxPending = options.maxPending ?? 20;
  }

  push(level: ShellNotice['level'], message: string): void {
    const key = `${level}:${message}`;
    const now = this.#now();
    if (now - (this.#recent.get(key) ?? Number.NEGATIVE_INFINITY) < this.#deduplicationMs) return;
    this.#recent.set(key, now);
    for (const [candidate, shownAt] of this.#recent) {
      if (now - shownAt >= this.#deduplicationMs) this.#recent.delete(candidate);
    }
    if (this.#subscribed) {
      this.#deliver({ level, message });
      return;
    }
    // The shell shows one notice at a time, so when too many accumulate the oldest are the ones it would replace anyway.
    this.#pending.push({ level, message });
    if (this.#pending.length > this.#maxPending) this.#pending.shift();
  }

  /** The shell has subscribed to events. Returns the notices held until now, oldest first, for delivery after bootstrap. */
  takePendingOnSubscribe(): ShellNotice[] {
    this.#subscribed = true;
    return this.#pending.splice(0);
  }

  /** The shell document is being replaced; notices are held until the new document subscribes again. */
  unsubscribe(): void {
    this.#subscribed = false;
  }
}
