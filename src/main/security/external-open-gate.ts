/**
 * Serializes external-protocol prompts: one native dialog at a time for the whole window, and a cooldown per source page
 * after each prompt so a page cannot lock the workspace by repeatedly navigating to mailto:/tel:.
 */
export class ExternalOpenGate {
  static readonly MAX_COOLDOWNS = 1000;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #blockedUntil = new Map<number, number>();
  #dialogOpen = false;

  constructor(cooldownMs = 5000, now: () => number = Date.now) {
    this.#cooldownMs = cooldownMs;
    this.#now = now;
  }

  get activeCooldownCount(): number {
    this.#pruneExpired(this.#now());
    return this.#blockedUntil.size;
  }

  #pruneExpired(currentTime: number): void {
    for (const [id, expiresAt] of this.#blockedUntil) {
      if (currentTime >= expiresAt) {
        this.#blockedUntil.delete(id);
      }
    }
  }

  tryAcquire(sourceId: number): boolean {
    const currentTime = this.#now();
    this.#pruneExpired(currentTime);
    if (this.#dialogOpen || currentTime < (this.#blockedUntil.get(sourceId) ?? 0)) return false;
    this.#dialogOpen = true;
    return true;
  }

  release(sourceId: number): void {
    const currentTime = this.#now();
    this.#dialogOpen = false;
    if (this.#cooldownMs > 0) {
      this.#blockedUntil.set(sourceId, currentTime + this.#cooldownMs);
      if (this.#blockedUntil.size > ExternalOpenGate.MAX_COOLDOWNS) {
        const oldest = this.#blockedUntil.keys().next().value;
        if (oldest !== undefined) this.#blockedUntil.delete(oldest);
      }
    }
    this.#pruneExpired(currentTime);
  }

  forget(sourceId: number): void {
    this.#blockedUntil.delete(sourceId);
  }
}
