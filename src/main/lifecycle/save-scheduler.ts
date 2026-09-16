export type SaveStatus = 'saved' | 'saving' | 'error';

export class SaveScheduler {
  readonly #save: () => Promise<void>;
  readonly #onStatus: (status: SaveStatus) => void;
  readonly #delayMs: number;
  #timer: NodeJS.Timeout | null = null;
  #dirty = false;
  #saving: Promise<void> | null = null;

  constructor(save: () => Promise<void>, onStatus: (status: SaveStatus) => void, delayMs = 450) {
    this.#save = save;
    this.#onStatus = onStatus;
    this.#delayMs = delayMs;
  }

  schedule(): void {
    this.#dirty = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#delayMs);
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#saving) {
      await this.#saving;
      if (this.#dirty) return this.flush();
      return;
    }
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#onStatus('saving');
    this.#saving = this.#save();
    try {
      await this.#saving;
      this.#onStatus('saved');
    } catch (error) {
      this.#dirty = true;
      this.#onStatus('error');
      throw error;
    } finally {
      this.#saving = null;
    }
    if (this.#dirty) await this.flush();
  }
}
