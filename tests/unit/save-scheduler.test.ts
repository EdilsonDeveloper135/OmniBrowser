import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveScheduler, type SaveStatus } from '../../src/main/lifecycle/save-scheduler';

afterEach(() => {
  vi.useRealTimers();
});

describe('SaveScheduler', () => {
  it('saves at most maxWait after the first change even while changes keep arriving', async () => {
    vi.useFakeTimers();
    let saves = 0;
    const scheduler = new SaveScheduler(async () => { saves += 1; }, () => undefined, { debounceMs: 450, maxWaitMs: 2000 });
    for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(saves).toBeGreaterThanOrEqual(4);
    expect(saves).toBeLessThanOrEqual(6);
  });

  it('still debounces a short burst into a single write', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const scheduler = new SaveScheduler(save, () => undefined, { debounceMs: 450, maxWaitMs: 2000 });
    for (let index = 0; index < 5; index += 1) {
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not let low-priority churn postpone or multiply saves', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const scheduler = new SaveScheduler(save, () => undefined, { idleDelayMs: 5000 });
    for (let elapsed = 0; elapsed < 9_900; elapsed += 100) {
      scheduler.schedule('idle');
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(save).toHaveBeenCalledTimes(1);
    scheduler.schedule('soon');
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('reports timer-driven failures without unhandled rejections and retries with backoff', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const statuses: SaveStatus[] = [];
    const errors: unknown[] = [];
    let attempts = 0;
    const scheduler = new SaveScheduler(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('disk full');
    }, (status) => statuses.push(status), { debounceMs: 10, retryBaseMs: 100, onError: (error) => errors.push(error) });
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(attempts).toBe(3);
    expect(statuses.at(-1)).toBe('saved');
    expect(statuses).toContain('error');
  });

  it('turns a synchronous throw from the save callback into a reported failure', async () => {
    const statuses: SaveStatus[] = [];
    const scheduler = new SaveScheduler(() => { throw new Error('invalid model'); }, (status) => statuses.push(status), { retryBaseMs: 60_000 });
    scheduler.schedule();
    await expect(scheduler.flush()).rejects.toThrow('invalid model');
    expect(statuses).toEqual(['saving', 'error']);
    expect(scheduler.isDirty).toBe(true);
    scheduler.dispose();
  });

  it('flush waits for an in-flight save and writes changes made meanwhile', async () => {
    let release: () => void = () => undefined;
    const writes: number[] = [];
    let version = 0;
    const scheduler = new SaveScheduler(async () => {
      const snapshot = version;
      if (writes.length === 0) await new Promise<void>((resolve) => { release = resolve; });
      writes.push(snapshot);
    }, () => undefined, { debounceMs: 0 });
    scheduler.schedule();
    const first = scheduler.flush();
    await Promise.resolve();
    version = 1;
    scheduler.schedule();
    const second = scheduler.flush();
    release();
    await Promise.all([first, second]);
    expect(writes).toEqual([0, 1]);
    expect(scheduler.isDirty).toBe(false);
  });

  it('stops scheduling after dispose', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const scheduler = new SaveScheduler(save, () => undefined);
    scheduler.schedule();
    scheduler.dispose();
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).not.toHaveBeenCalled();
  });
});
