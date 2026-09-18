import { randomBytes, randomUUID } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebContents } from 'electron';
import WebSocket, { WebSocketServer } from 'ws';
import { MAX_URL_LENGTH } from '../../shared/constants';
import { isAllowedNavigationUrl } from '../../shared/urls';
import { withSyntheticInput } from '../browser/automation-input';
import type { AutomationTarget } from '../browser/browser-runtime';

const MAX_CDP_MESSAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_JPEG_QUALITY = 80;
// While a navigation swaps the page's compositor surface, capturePage fails ("UnknownVizError") or returns an empty
// image for one or two frames. Browser Use takes its screenshot right after navigating, so those frames are retried.
const CAPTURE_ATTEMPTS = 5;
const CAPTURE_RETRY_DELAY_MS = 100;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, JsonValue>;
  sessionId?: string;
}

const FORWARDED_DOMAINS = new Set([
  'Accessibility',
  'DOM',
  'DOMDebugger',
  'DOMSnapshot',
  'Emulation',
  'Input',
  'Log',
  'Network',
  'Page',
  'Performance',
  'Runtime',
  'Schema'
]);

// Methods of forwarded domains that would reach beyond the page the agent was given: credentials, local files,
// downloads, the card's own lifecycle and the user's history.
const DENIED_METHODS = new Set([
  'DOM.setFileInputFiles',
  'Network.clearBrowserCache',
  'Network.clearBrowserCookies',
  'Network.deleteCookies',
  'Network.getAllCookies',
  'Network.getCookies',
  'Network.loadNetworkResource',
  'Network.setCookie',
  'Network.setCookies',
  'Page.close',
  'Page.crash',
  'Page.handleFileChooser',
  'Page.printToPDF',
  'Page.resetNavigationHistory',
  'Page.setDownloadBehavior',
  'Page.setInterceptFileChooserDialog'
]);

function json(response: http.ServerResponse, statusCode: number, value: JsonValue): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequest(raw: WebSocket.RawData): CdpRequest | null {
  const buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buffer.byteLength > MAX_CDP_MESSAGE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    if (!isRecord(value) || !Number.isSafeInteger(value.id) || typeof value.method !== 'string') return null;
    if (value.params !== undefined && !isRecord(value.params)) return null;
    if (value.sessionId !== undefined && typeof value.sessionId !== 'string') return null;
    return value as unknown as CdpRequest;
  } catch {
    return null;
  }
}

function cdpError(id: number, message: string, code = -32000): Record<string, JsonValue> {
  return { id, error: { code, message } };
}

function finiteNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface ScopedCdpGatewayOptions {
  target: AutomationTarget;
  onDetached?: (reason: string) => void;
}

/**
 * Converts Electron's per-WebContents debugger transport into a capability URL understood by Browser Use.
 * The gateway intentionally presents a virtual one-page browser and never enumerates Electron's global targets.
 */
export class ScopedCdpGateway {
  readonly #target: AutomationTarget;
  readonly #onDetached: (reason: string) => void;
  readonly #capability = randomBytes(32).toString('base64url');
  readonly #browserTargetId = `browser-${randomUUID()}`;
  readonly #pageTargetId: string;
  readonly #pageSessionId = `session-${randomUUID()}`;
  readonly #server: http.Server;
  readonly #webSockets: WebSocketServer;
  #client: WebSocket | null = null;
  #cdpUrl: string | null = null;
  #started = false;
  #stopped = false;
  #attachedByGateway = false;
  #pageAttached = false;
  #discoverTargets = false;

  constructor(options: ScopedCdpGatewayOptions) {
    this.#target = options.target;
    this.#pageTargetId = options.target.targetId;
    this.#onDetached = options.onDetached ?? (() => undefined);
    this.#server = http.createServer((request, response) => this.#handleHttp(request, response));
    this.#webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CDP_MESSAGE_BYTES, perMessageDeflate: false });
    this.#server.on('upgrade', (request, socket, head) => {
      if (this.#stopped || request.url !== this.#webSocketPath() || this.#client) {
        socket.destroy();
        return;
      }
      this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => this.#accept(webSocket));
    });
  }

  get browserId(): string {
    return this.#target.browserId;
  }

  get runtimeEpoch(): number {
    return this.#target.runtimeEpoch;
  }

  get cdpUrl(): string {
    if (!this.#cdpUrl) throw new Error('La pasarela CDP todavía no está disponible.');
    return this.#cdpUrl;
  }

  async start(): Promise<string> {
    if (this.#started) return this.cdpUrl;
    if (this.#stopped) throw new Error('La pasarela CDP ya fue cerrada.');
    const { contents } = this.#target;
    if (contents.isDestroyed()) throw new Error('El browser ya no está disponible.');

    const debug = contents.debugger;
    if (debug.isAttached()) throw new Error('El browser ya tiene una sesión de depuración activa.');
    debug.attach('1.3');
    this.#attachedByGateway = true;
    debug.on('message', this.#handleDebuggerMessage);
    debug.once('detach', this.#handleDebuggerDetach);
    contents.on('did-navigate', this.#handleNavigation);
    contents.on('did-navigate-in-page', this.#handleInPageNavigation);
    contents.on('page-title-updated', this.#handleNavigation);
    contents.on('render-process-gone', this.#handleRenderProcessGone);

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.removeListener('error', onError);
        resolve();
      };
      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen(0, '127.0.0.1');
    });
    const address = this.#server.address() as AddressInfo;
    this.#cdpUrl = `http://127.0.0.1:${address.port}${this.#basePath()}`;
    this.#started = true;
    return this.#cdpUrl;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const client = this.#client;
    this.#client = null;
    if (client && client.readyState < WebSocket.CLOSING) client.close(1001, 'Target revoked');
    for (const connection of this.#webSockets.clients) connection.terminate();
    this.#webSockets.close();
    await new Promise<void>((resolve) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
    const { contents } = this.#target;
    const debug = contents.debugger;
    debug.removeListener('message', this.#handleDebuggerMessage);
    debug.removeListener('detach', this.#handleDebuggerDetach);
    contents.removeListener('did-navigate', this.#handleNavigation);
    contents.removeListener('did-navigate-in-page', this.#handleInPageNavigation);
    contents.removeListener('page-title-updated', this.#handleNavigation);
    contents.removeListener('render-process-gone', this.#handleRenderProcessGone);
    if (this.#attachedByGateway && !contents.isDestroyed() && debug.isAttached()) {
      try {
        debug.detach();
      } catch {
        // The render process may have disappeared between isAttached() and detach().
      }
    }
    this.#attachedByGateway = false;
  }

  #basePath(): string {
    return `/cdp/${this.#capability}`;
  }

  #webSocketPath(): string {
    return `${this.#basePath()}/devtools/browser/${this.#browserTargetId}`;
  }

  #handleHttp(request: IncomingMessage, response: http.ServerResponse): void {
    if (request.method !== 'GET' || this.#stopped) {
      json(response, 404, { error: 'Not found' });
      return;
    }
    const address = this.#server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const socketUrl = `ws://127.0.0.1:${port}${this.#webSocketPath()}`;
    if (request.url === `${this.#basePath()}/json/version`) {
      json(response, 200, {
        Browser: `OmniBrowser/${process.versions.electron ?? 'unknown'}`,
        'Protocol-Version': '1.3',
        'User-Agent': 'OmniBrowser Agent Gateway',
        webSocketDebuggerUrl: socketUrl
      });
      return;
    }
    if (request.url === `${this.#basePath()}/json/list` || request.url === `${this.#basePath()}/json`) {
      json(response, 200, [{
        id: this.#pageTargetId,
        type: 'page',
        title: 'OmniBrowser',
        url: this.#target.contents.isDestroyed() ? 'about:blank' : this.#target.contents.getURL(),
        webSocketDebuggerUrl: socketUrl
      }]);
      return;
    }
    json(response, 404, { error: 'Not found' });
  }

  #accept(webSocket: WebSocket): void {
    if (this.#client) {
      webSocket.close(1008, 'Only one agent may attach');
      return;
    }
    this.#client = webSocket;
    webSocket.on('message', (raw) => {
      const request = parseRequest(raw);
      if (!request) {
        webSocket.close(1007, 'Invalid CDP message');
        return;
      }
      void this.#dispatch(request);
    });
    webSocket.once('close', () => {
      if (this.#client === webSocket) this.#client = null;
      this.#pageAttached = false;
      this.#discoverTargets = false;
    });
  }

  async #dispatch(request: CdpRequest): Promise<void> {
    if (this.#stopped || !this.#client || this.#client.readyState !== WebSocket.OPEN) return;
    try {
      const result = await this.#handleCommand(request);
      this.#send({ id: request.id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'CDP command failed.';
      this.#send(cdpError(request.id, message));
    }
  }

  async #handleCommand(request: CdpRequest): Promise<Record<string, JsonValue>> {
    const params = request.params ?? {};
    if (request.sessionId !== undefined && request.sessionId !== this.#pageSessionId) {
      throw new Error('Unknown or revoked target session.');
    }

    switch (request.method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: `OmniBrowser/${process.versions.electron ?? 'unknown'}`,
          revision: '',
          userAgent: 'OmniBrowser Agent Gateway',
          jsVersion: process.versions.v8 ?? ''
        };
      case 'Browser.getWindowForTarget':
        this.#assertOwnTarget(params.targetId);
        return { windowId: 1, bounds: { windowState: 'normal' } };
      case 'Browser.getWindowBounds':
        return { bounds: { windowState: 'normal' } };
      case 'Target.setDiscoverTargets': {
        const discover = params.discover === true;
        const announce = discover && !this.#discoverTargets;
        this.#discoverTargets = discover;
        if (announce) queueMicrotask(() => this.#send({ method: 'Target.targetCreated', params: { targetInfo: this.#targetInfo() } }));
        return {};
      }
      case 'Target.setAutoAttach':
        return {};
      case 'Target.detachFromTarget':
        this.#pageAttached = false;
        return {};
      case 'Target.getBrowserContexts':
        return { browserContextIds: [] };
      case 'Target.getTargets':
        return { targetInfos: [this.#targetInfo()] };
      case 'Target.getTargetInfo':
        this.#assertOwnTarget(params.targetId);
        return { targetInfo: this.#targetInfo() };
      case 'Target.attachToTarget': {
        this.#assertOwnTarget(params.targetId);
        this.#pageAttached = true;
        queueMicrotask(() => this.#send({
          method: 'Target.attachedToTarget',
          params: { sessionId: this.#pageSessionId, targetInfo: this.#targetInfo(), waitingForDebugger: false }
        }));
        return { sessionId: this.#pageSessionId };
      }
      case 'Target.activateTarget':
        this.#assertOwnTarget(params.targetId);
        return {};
      // The card is placed by the user on the canvas; an agent must not raise it or focus the window.
      case 'Page.bringToFront':
        return {};
      case 'Target.createTarget':
      case 'Target.closeTarget':
      case 'Browser.setWindowBounds':
      case 'Browser.setDownloadBehavior':
        throw new Error(`${request.method} is not permitted for a card-scoped agent.`);
      default:
        break;
    }

    const [domain] = request.method.split('.', 1);
    if (!domain || !FORWARDED_DOMAINS.has(domain) || DENIED_METHODS.has(request.method)) {
      throw new Error(`${request.method} is outside the audited card-scoped CDP surface.`);
    }
    this.#assertTargetAlive();
    if (request.method === 'Page.navigate') this.#assertNavigable(params.url);
    if (request.method === 'Page.captureScreenshot') return this.#captureScreenshot(params);
    if (domain === 'Input') return withSyntheticInput(this.#target.contents, () => this.#forward(request.method, params));
    return this.#forward(request.method, params);
  }

  async #forward(method: string, params: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
    const result = await this.#target.contents.debugger.sendCommand(method, params);
    return result as Record<string, JsonValue>;
  }

  /**
   * Chromium only produces frames for a visible page, so Page.captureScreenshot never answers while the card is off
   * screen, covered, minimized, collapsed or the window is hidden. capturePage requests a frame for the capture without
   * making the page visible, so the page observes no visibility change.
   */
  async #captureScreenshot(params: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
    const format = params.format ?? 'png';
    if (params.captureBeyondViewport === true || (format !== 'png' && format !== 'jpeg')) {
      return this.#forward('Page.captureScreenshot', params);
    }
    let rect: Electron.Rectangle | undefined;
    let scale = 1;
    if (params.clip !== undefined) {
      const clip = isRecord(params.clip) ? params.clip as Record<string, JsonValue> : {};
      const x = finiteNumber(clip.x);
      const y = finiteNumber(clip.y);
      const width = finiteNumber(clip.width);
      const height = finiteNumber(clip.height);
      if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
        throw new Error('Invalid screenshot clip.');
      }
      scale = finiteNumber(clip.scale) ?? 1;
      if (scale <= 0) throw new Error('Invalid screenshot clip.');
      // CDP clips are expressed in document coordinates; capturePage only sees the current viewport.
      const metrics = await this.#forward('Page.getLayoutMetrics', {});
      const viewport = isRecord(metrics.cssVisualViewport) ? metrics.cssVisualViewport as Record<string, JsonValue> : {};
      const left = x - (finiteNumber(viewport.pageX) ?? 0);
      const top = y - (finiteNumber(viewport.pageY) ?? 0);
      const clientWidth = finiteNumber(viewport.clientWidth) ?? 0;
      const clientHeight = finiteNumber(viewport.clientHeight) ?? 0;
      if (left < 0 || top < 0 || left + width > clientWidth + 1 || top + height > clientHeight + 1) {
        return this.#forward('Page.captureScreenshot', params);
      }
      rect = { x: Math.round(left), y: Math.round(top), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
    }
    const image = await this.#capturePage(rect);
    const sized = scale === 1
      ? image
      : image.resize({ width: Math.max(1, Math.round(image.getSize().width * scale)), quality: 'good' });
    const quality = finiteNumber(params.quality);
    const encoded = format === 'jpeg'
      ? sized.toJPEG(Math.min(100, Math.max(0, Math.round(quality ?? DEFAULT_JPEG_QUALITY))))
      : sized.toPNG();
    return { data: encoded.toString('base64') };
  }

  async #capturePage(rect: Electron.Rectangle | undefined): Promise<Electron.NativeImage> {
    const contents: WebContents = this.#target.contents;
    let failure: unknown = null;
    for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, CAPTURE_RETRY_DELAY_MS));
      this.#assertTargetAlive();
      try {
        const image = await contents.capturePage(rect, { stayHidden: true });
        if (!image.isEmpty()) return image;
        failure = null;
      } catch (error) {
        failure = error;
      }
    }
    throw failure instanceof Error ? failure : new Error('The browser did not produce a frame for the screenshot.');
  }

  #assertTargetAlive(): void {
    if (this.#target.contents.isDestroyed() || this.#target.contents.id !== this.#target.contentsId) {
      throw new Error('The browser target was revoked.');
    }
  }

  /** Page.navigate is browser-initiated, so it bypasses the card's will-navigate guard; the same policy applies here. */
  #assertNavigable(url: JsonValue | undefined): void {
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH || !isAllowedNavigationUrl(url)) {
      throw new Error('Navigation to this URL is not permitted for a card-scoped agent; use http or https.');
    }
  }

  #targetInfo(): Record<string, JsonValue> {
    const contents: WebContents = this.#target.contents;
    return {
      targetId: this.#pageTargetId,
      type: 'page',
      title: contents.isDestroyed() ? 'OmniBrowser' : contents.getTitle(),
      url: contents.isDestroyed() ? 'about:blank' : contents.getURL(),
      attached: this.#pageAttached,
      canAccessOpener: false,
      browserContextId: 'omnibrowser-card'
    };
  }

  #assertOwnTarget(targetId: JsonValue | undefined): void {
    if (targetId !== undefined && targetId !== this.#pageTargetId) throw new Error('Cross-browser target access denied.');
  }

  #send(payload: Record<string, JsonValue>): void {
    const client = this.#client;
    if (!client || client.readyState !== WebSocket.OPEN) return;
    client.send(JSON.stringify(payload));
  }

  // Electron's debugger session is never given the Target domain, so the gateway announces the URL and title changes
  // that Chromium would report to a browser-level client with target discovery enabled.
  readonly #handleNavigation = (): void => {
    if (this.#stopped || !this.#discoverTargets) return;
    this.#send({ method: 'Target.targetInfoChanged', params: { targetInfo: this.#targetInfo() } });
  };

  readonly #handleInPageNavigation = (_event: Electron.Event, _url: string, isMainFrame: boolean): void => {
    if (isMainFrame) this.#handleNavigation();
  };

  readonly #handleDebuggerMessage = (_event: Electron.Event, method: string, params: unknown): void => {
    if (this.#stopped || method.startsWith('Target.')) return;
    const safeParams = isRecord(params) ? params as Record<string, JsonValue> : {};
    const payload: Record<string, JsonValue> = { method, params: safeParams };
    if (this.#pageAttached) payload.sessionId = this.#pageSessionId;
    this.#send(payload);
  };

  readonly #handleDebuggerDetach = (_event: Electron.Event, reason: string): void => {
    if (this.#stopped) return;
    this.#attachedByGateway = false;
    this.#onDetached(reason);
    void this.stop();
  };

  readonly #handleRenderProcessGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
    if (this.#stopped || details.reason === 'clean-exit') return;
    this.#onDetached('crashed');
    void this.stop();
  };
}
