/**
 * Serializes external-protocol prompts: one native dialog at a time for the whole window, and a cooldown per source page
 * after each prompt so a page cannot lock the workspace by repeatedly navigating to mailto:/tel:.
 */
export class ExternalOpenGate {
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #blockedUntil = new Map<number, number>();
  #dialogOpen = false;

  constructor(cooldownMs = 5000, now: () => number = Date.now) {
    this.#cooldownMs = cooldownMs;
    this.#now = now;
  }

  tryAcquire(sourceId: number): boolean {
    if (this.#dialogOpen || this.#now() < (this.#blockedUntil.get(sourceId) ?? 0)) return false;
    this.#dialogOpen = true;
    return true;
  }

  release(sourceId: number): void {
    this.#dialogOpen = false;
    this.#blockedUntil.set(sourceId, this.#now() + this.#cooldownMs);
  }

  forget(sourceId: number): void {
    this.#blockedUntil.delete(sourceId);
  }
}
