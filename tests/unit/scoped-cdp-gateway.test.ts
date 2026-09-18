import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ScopedCdpGateway } from '../../src/main/agents/scoped-cdp-gateway';
import { isSyntheticInputInFlight } from '../../src/main/browser/automation-input';
import type { AutomationTarget } from '../../src/main/browser/browser-runtime';

class FakeDebugger extends EventEmitter {
  attached = false;
  sendCommand = vi.fn(async (method: string, _params?: object): Promise<Record<string, unknown>> => ({ echoedMethod: method }));

  attach(): void {
    if (this.attached) throw new Error('already attached');
    this.attached = true;
  }

  isAttached(): boolean {
    return this.attached;
  }

  detach(): void {
    this.attached = false;
    this.emit('detach', {}, 'target closed');
  }
}

class FakeImage {
  readonly size: { width: number; height: number };

  constructor(size: { width: number; height: number }) {
    this.size = size;
  }

  isEmpty() { return false; }
  getSize() { return this.size; }
  resize(options: { width: number }) { return new FakeImage({ width: options.width, height: Math.round(this.size.height * options.width / this.size.width) }); }
  toPNG() { return Buffer.from(`png:${this.size.width}x${this.size.height}`); }
  toJPEG(quality: number) { return Buffer.from(`jpeg:${quality}:${this.size.width}x${this.size.height}`); }
}

class FakeContents extends EventEmitter {
  readonly id = 17;
  url = 'https://example.test/';
  title = 'Example';
  readonly debugger: FakeDebugger;
  capturePage = vi.fn(async (rect?: { width: number; height: number }) => new FakeImage(rect ? { width: rect.width * 2, height: rect.height * 2 } : { width: 1200, height: 800 }));

  constructor(debuggerInstance: FakeDebugger) {
    super();
    this.debugger = debuggerInstance;
  }

  isDestroyed() { return false; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
}

function target(contents: FakeContents): AutomationTarget {
  return {
    browserId: randomUUID(),
    profileId: randomUUID(),
    contents: contents as unknown as Electron.WebContents,
    contentsId: contents.id,
    targetId: 'only-card-target',
    runtimeEpoch: 3
  };
}

async function request(socket: WebSocket, id: number, method: string, params?: object, sessionId?: string): Promise<Record<string, unknown>> {
  const response = new Promise<Record<string, unknown>>((resolve) => {
    const listener = (raw: WebSocket.RawData) => {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (value.id !== id) return;
      socket.off('message', listener);
      resolve(value);
    };
    socket.on('message', listener);
  });
  socket.send(JSON.stringify({ id, method, params, sessionId }));
  return response;
}

function collect(socket: WebSocket): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (raw: WebSocket.RawData) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  return messages;
}

describe('ScopedCdpGateway', () => {
  const gateways: ScopedCdpGateway[] = [];

  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  });

  async function connect(options: { onDetached?: (reason: string) => void } = {}) {
    const fakeDebugger = new FakeDebugger();
    const contents = new FakeContents(fakeDebugger);
    const gateway = new ScopedCdpGateway({ target: target(contents), ...options });
    gateways.push(gateway);
    const cdpUrl = await gateway.start();
    const version = await fetch(`${cdpUrl}/json/version`).then(async (response) => response.json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await once(socket, 'open');
    return { gateway, fakeDebugger, contents, socket, cdpUrl };
  }

  it('publishes only its card target and forwards audited page commands', async () => {
    const { fakeDebugger, socket } = await connect();

    const targets = await request(socket, 1, 'Target.getTargets');
    expect(targets).toMatchObject({
      id: 1,
      result: { targetInfos: [{ targetId: 'only-card-target', type: 'page' }] }
    });

    const attached = await request(socket, 2, 'Target.attachToTarget', { targetId: 'only-card-target', flatten: true });
    const sessionId = (attached.result as { sessionId: string }).sessionId;
    const runtime = await request(socket, 3, 'Runtime.evaluate', { expression: 'document.title' }, sessionId);
    expect(runtime).toMatchObject({ id: 3, result: { echoedMethod: 'Runtime.evaluate' } });
    expect(fakeDebugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', { expression: 'document.title' });
    expect(await request(socket, 4, 'Runtime.evaluate', {}, 'forged-session')).toHaveProperty('error');
  });

  it('denies foreign targets, new tabs, cookie export, local files and the card lifecycle', async () => {
    const { fakeDebugger, socket } = await connect();

    expect(await request(socket, 1, 'Target.attachToTarget', { targetId: 'another-card' })).toHaveProperty('error');
    expect(await request(socket, 2, 'Target.createTarget', { url: 'https://example.com' })).toHaveProperty('error');
    expect(await request(socket, 3, 'Network.getAllCookies')).toHaveProperty('error');
    expect(await request(socket, 4, 'DOM.setFileInputFiles', { files: ['/tmp/secret'] })).toHaveProperty('error');
    expect(await request(socket, 5, 'Network.loadNetworkResource', { url: 'file:///etc/hosts' })).toHaveProperty('error');
    expect(await request(socket, 6, 'Page.close')).toHaveProperty('error');
    expect(await request(socket, 7, 'Page.crash')).toHaveProperty('error');
    expect(await request(socket, 8, 'Storage.getCookies')).toHaveProperty('error');
    expect(await request(socket, 9, 'Browser.close')).toHaveProperty('error');
    expect(fakeDebugger.sendCommand).not.toHaveBeenCalled();
  });

  it('applies the card navigation policy to CDP navigation, which bypasses will-navigate', async () => {
    const { fakeDebugger, socket } = await connect();

    for (const [id, url] of [[1, 'file:///etc/hosts'], [2, 'javascript:alert(1)'], [3, 'chrome://settings'], [4, 'data:text/html,hi'], [5, 'https://user:pass@example.com/']] as const) {
      expect(await request(socket, id, 'Page.navigate', { url })).toHaveProperty('error');
    }
    expect(await request(socket, 6, 'Page.navigate', {})).toHaveProperty('error');
    expect(fakeDebugger.sendCommand).not.toHaveBeenCalled();
    expect(await request(socket, 7, 'Page.navigate', { url: 'https://example.com/next' })).toMatchObject({ result: { echoedMethod: 'Page.navigate' } });
    expect(await request(socket, 8, 'Page.navigate', { url: 'about:blank' })).toMatchObject({ result: { echoedMethod: 'Page.navigate' } });
  });

  it('announces URL and title changes of its own card only once discovery is enabled', async () => {
    const { fakeDebugger, contents, socket } = await connect();
    const messages = collect(socket);

    contents.emit('did-navigate', {}, 'https://example.test/before');
    fakeDebugger.emit('message', {}, 'Target.targetInfoChanged', {
      targetInfo: { targetId: 'another-card', url: 'https://private-neighbor.test/', title: 'Neighbor' }
    });
    await request(socket, 1, 'Target.setDiscoverTargets', { discover: true });
    expect(messages.filter((message) => message.method)).toEqual([
      { method: 'Target.targetCreated', params: { targetInfo: expect.objectContaining({ targetId: 'only-card-target' }) } }
    ]);

    contents.url = 'https://example.test/after';
    contents.title = 'After';
    contents.emit('did-navigate', {}, contents.url);
    contents.emit('did-navigate-in-page', {}, 'https://frame.test/', false);
    await request(socket, 2, 'Target.getTargets');
    const changes = messages.filter((message) => message.method === 'Target.targetInfoChanged');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      params: { targetInfo: { targetId: 'only-card-target', url: 'https://example.test/after', title: 'After', canAccessOpener: false } }
    });
    expect(JSON.stringify(messages)).not.toContain('private-neighbor');
  });

  it('captures screenshots without a visible frame and keeps CDP semantics for clips and full pages', async () => {
    const { fakeDebugger, contents, socket } = await connect();

    const png = await request(socket, 1, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    expect(Buffer.from((png.result as { data: string }).data, 'base64').toString()).toBe('png:1200x800');
    expect(contents.capturePage).toHaveBeenLastCalledWith(undefined, { stayHidden: true });

    const jpeg = await request(socket, 2, 'Page.captureScreenshot', { format: 'jpeg', quality: 55 });
    expect(Buffer.from((jpeg.result as { data: string }).data, 'base64').toString()).toBe('jpeg:55:1200x800');

    fakeDebugger.sendCommand.mockImplementation(async (method: string) => method === 'Page.getLayoutMetrics'
      ? { cssVisualViewport: { pageX: 0, pageY: 400, clientWidth: 600, clientHeight: 400 } }
      : { echoedMethod: method });
    await request(socket, 3, 'Page.captureScreenshot', { format: 'png', clip: { x: 10, y: 420, width: 100, height: 50, scale: 1 } });
    expect(contents.capturePage).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 100, height: 50 }, { stayHidden: true });

    // Regions outside the viewport and full-page captures need Chromium's own emulation.
    expect(await request(socket, 4, 'Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 100, height: 50, scale: 1 } }))
      .toMatchObject({ result: { echoedMethod: 'Page.captureScreenshot' } });
    expect(await request(socket, 5, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }))
      .toMatchObject({ result: { echoedMethod: 'Page.captureScreenshot' } });
    expect(await request(socket, 6, 'Page.captureScreenshot', { clip: { x: 1, y: 1, width: -3, height: 5 } })).toHaveProperty('error');
  });

  it('retries the frames a navigation loses while it swaps the page surface', async () => {
    const { contents, socket } = await connect();
    const empty = Object.assign(new FakeImage({ width: 0, height: 0 }), { isEmpty: () => true });
    contents.capturePage
      .mockRejectedValueOnce(new Error('UnknownVizError'))
      .mockResolvedValueOnce(empty);
    const png = await request(socket, 1, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    expect(Buffer.from((png.result as { data: string }).data, 'base64').toString()).toBe('png:1200x800');
    expect(contents.capturePage).toHaveBeenCalledTimes(3);

    // A page that never produces a frame still answers, with the browser's reason, instead of hanging Browser Use.
    contents.capturePage.mockRejectedValue(new Error('UnknownVizError'));
    expect(await request(socket, 2, 'Page.captureScreenshot', { format: 'png' })).toMatchObject({ error: { message: 'UnknownVizError' } });
    expect(contents.capturePage).toHaveBeenCalledTimes(8);
  });

  it('marks agent input as synthetic while it is dispatched', async () => {
    const { fakeDebugger, contents, socket } = await connect();
    const observed: boolean[] = [];
    fakeDebugger.sendCommand.mockImplementation(async (method: string) => {
      observed.push(isSyntheticInputInFlight(contents as unknown as Electron.WebContents));
      return { echoedMethod: method };
    });
    await request(socket, 1, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
    await request(socket, 2, 'Runtime.evaluate', { expression: '1' });
    expect(observed).toEqual([true, false]);
    expect(isSyntheticInputInFlight(contents as unknown as Electron.WebContents)).toBe(false);
  });

  it('never raises the card and revokes itself when the page crashes', async () => {
    const detached: string[] = [];
    const { fakeDebugger, contents, socket } = await connect({ onDetached: (reason) => { detached.push(reason); } });
    expect(await request(socket, 1, 'Page.bringToFront')).toEqual({ id: 1, result: {} });
    expect(fakeDebugger.sendCommand).not.toHaveBeenCalled();

    const closed = once(socket, 'close');
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await closed;
    expect(detached).toEqual(['crashed']);
    expect(fakeDebugger.isAttached()).toBe(false);
    expect(contents.listenerCount('did-navigate')).toBe(0);
  });
});
