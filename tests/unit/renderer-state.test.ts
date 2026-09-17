import { describe, expect, it, vi } from 'vitest';
import { LayoutCommitter } from '../../src/renderer/lib/layout-committer';
import { mergeBrowserState, mergeWorkspaceSnapshot } from '../../src/renderer/lib/snapshot-merge';
import type { BrowserSnapshot, LayoutBatch, WorkspaceSnapshot } from '../../src/shared/schemas';
import { raiseToTop } from '../../src/shared/z-order';

function batch(x: number): LayoutBatch {
  return { items: [{ browserId: '6c53840e-68e4-4c65-a767-24924cf02a60', worldRect: { x, y: 0, width: 320, height: 240 }, screenBounds: { x, y: 0, width: 10, height: 10 }, visible: true }] };
}

function manualFrames() {
  const callbacks: Array<() => void> = [];
  return {
    request: (callback: () => void) => callbacks.push(callback),
    cancel: vi.fn(),
    run: () => { for (const callback of callbacks.splice(0)) callback(); }
  };
}

function browser(id: string, overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return {
    id,
    profileId: 'p',
    zoneId: null,
    worldRect: { x: 0, y: 0, width: 320, height: 240 },
    zIndex: 1,
    url: 'about:blank',
    title: 'Nueva página',
    suspended: false,
    presentation: 'normal',
    positionLocked: false,
    pin: { sidebar: false, viewport: null },
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    runtime: { isAwake: true, isLoading: false, canGoBack: false, canGoForward: false, crashed: false, isAudible: false, faviconKey: null, download: { activeCount: 0, receivedBytes: 0, totalBytes: null, status: 'idle' }, lastError: null },
    ...overrides
  };
}

function snapshot(browsers: BrowserSnapshot[], camera = { panX: 0, panY: 0, zoom: 1 }): WorkspaceSnapshot {
  return { schemaVersion: 2, profiles: [], browsers, zones: [], stacks: [], browserOrder: browsers.map(({ id }) => id), preferences: { snapEnabled: false, historySwipeEnabled: false }, camera, selectedBrowserId: null, saveStatus: 'saved', createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' };
}

describe('LayoutCommitter', () => {
  it('coalesces a burst into one request per frame and keeps a single request in flight', async () => {
    const frames = manualFrames();
    const sent: LayoutBatch[] = [];
    let resolveSend: () => void = () => undefined;
    const committer = new LayoutCommitter((layout) => {
      sent.push(layout);
      return new Promise<void>((resolve) => { resolveSend = resolve; });
    }, vi.fn(), frames.request, frames.cancel);
    for (let x = 0; x < 60; x += 1) committer.submit(batch(x));
    frames.run();
    expect(sent).toEqual([batch(59)]);
    committer.submit(batch(60));
    committer.submit(batch(61));
    frames.run();
    expect(sent).toHaveLength(1);
    resolveSend();
    await new Promise((resolve) => setTimeout(resolve, 0));
    frames.run();
    expect(sent).toEqual([batch(59), batch(61)]);
  });

  it('does not resend identical layouts but retries after a failed request', async () => {
    const frames = manualFrames();
    const onError = vi.fn();
    const send = vi.fn().mockRejectedValueOnce(new Error('bridge unavailable')).mockResolvedValue(undefined);
    const committer = new LayoutCommitter(send, onError, frames.request, frames.cancel);
    committer.submit(batch(1));
    frames.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledTimes(1);
    committer.submit(batch(1));
    frames.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    committer.submit(batch(1));
    frames.run();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('snapshot merging during gestures', () => {
  it('keeps the dragged card geometry and the panned camera while main-process snapshots arrive', () => {
    const local = snapshot([browser('a', { worldRect: { x: 400, y: 300, width: 320, height: 240 } }), browser('b')], { panX: -90, panY: 12, zoom: 1 });
    const incoming = snapshot([browser('a', { title: 'Nuevo título' }), browser('b', { worldRect: { x: 5, y: 5, width: 320, height: 240 } })]);
    const duringCardDrag = mergeWorkspaceSnapshot(local, incoming, { kind: 'cards', browserIds: ['a'] });
    expect(duringCardDrag.browsers[0]).toMatchObject({ title: 'Nuevo título', worldRect: { x: 400, y: 300 } });
    expect(duringCardDrag.browsers[1]?.worldRect.x).toBe(5);
    expect(mergeWorkspaceSnapshot(local, incoming, { kind: 'canvas' }).camera).toEqual(local.camera);
    expect(mergeWorkspaceSnapshot(local, incoming, null)).toBe(incoming);
  });

  it('applies browser runtime state without overwriting geometry or z-order', () => {
    const local = snapshot([browser('a', { worldRect: { x: 400, y: 300, width: 320, height: 240 }, zIndex: 3 })]);
    const merged = mergeBrowserState(local, browser('a', { title: 'Cargando', runtime: { isAwake: true, isLoading: true, canGoBack: true, canGoForward: false, crashed: false, isAudible: false, faviconKey: null, download: { activeCount: 0, receivedBytes: 0, totalBytes: null, status: 'idle' }, lastError: null } }));
    expect(merged?.browsers[0]).toMatchObject({ title: 'Cargando', zIndex: 3, worldRect: { x: 400, y: 300 }, runtime: { isLoading: true, canGoBack: true } });
  });
});

describe('raiseToTop', () => {
  it('moves the target to the top and renumbers densely without changing the relative order of others', () => {
    const items = [
      { id: 'a', zIndex: 10, createdAt: '1' },
      { id: 'b', zIndex: 4, createdAt: '2' },
      { id: 'c', zIndex: 900_000, createdAt: '3' }
    ];
    expect(raiseToTop(items, 'b').map(({ id, zIndex }) => [id, zIndex])).toEqual([['a', 1], ['b', 3], ['c', 2]]);
    expect(raiseToTop(items, 'missing')).toEqual(items);
  });
});
