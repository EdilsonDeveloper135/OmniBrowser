import type { BrowserWindowConstructorOptions, Event, Input, Session, WebContents } from 'electron';
import { BrowserWindow, WebContentsView } from 'electron';
import {
  DEFAULT_BROWSER_URL,
  PROFILE_RAIL_WIDTH,
  STATUS_BAR_HEIGHT,
  TOOLBAR_HEIGHT
} from '../../shared/constants';
import { OmniUserError } from '../../shared/errors';
import { sameBounds } from '../../shared/geometry';
import type { BrowserRecord, BrowserRuntimeState, LayoutBatch, ScreenRect } from '../../shared/schemas';
import { displayDomain, isAllowedNavigationUrl, isPersistableNavigationUrl, normalizeNavigationInput, parseExternalUrl } from '../../shared/urls';
import { sanitizeHistory } from '../domain/navigation-history';
import { BrowserNotFoundError, WorkspaceModel, type NavigationChange } from '../domain/workspace-model';
import type { SaveUrgency } from '../lifecycle/save-scheduler';
import { ProfileSessionManager } from '../profiles/profile-session-manager';
import { registerDownloadWebContents, remoteWebPreferences } from '../security/security-policy';
import { captureFavicon, clearFaviconCache } from './favicon-cache';

const NET_ERROR_ABORTED = -3;
// Chromium navigation/title events are coalesced per browser into at most one capture and one shell update per interval.
const NAVIGATION_SYNC_INTERVAL_MS = 250;

interface RuntimeEntry {
  readonly view: WebContentsView;
  readonly contents: WebContents;
  readonly contentsId: number;
  readonly state: BrowserRuntimeState;
  // Incremented by every navigation OmniBrowser starts; a restore fallback only runs if no newer navigation superseded it.
  navigationToken: number;
  appliedBounds: ScreenRect | null;
  appliedVisible: boolean;
  surfaceLayer: 'normal' | 'pinned' | 'immersive';
  unregisterDownload: () => void;
  disposed: boolean;
}

interface BrowserRuntimeOptions {
  window: BrowserWindow;
  model: WorkspaceModel;
  sessions: ProfileSessionManager;
  scheduleSave: (urgency?: SaveUrgency) => void;
  onModelChanged: () => void;
  onBrowserChanged: (browserId: string) => void;
  onNotice: (level: 'info' | 'warning' | 'error', message: string) => void;
  onExternalUrl: (url: string, sourceContentsId: number) => void;
  onNativeBrowserClick?: (browserId: string, shiftKey: boolean) => void;
  onNativeBrowserEscape?: (browserId: string) => void;
  onContentsDestroyed?: (contentsId: number) => void;
}

export class BrowserRuntime {
  readonly #window: BrowserWindow;
  readonly #model: WorkspaceModel;
  readonly #sessions: ProfileSessionManager;
  readonly #scheduleSave: (urgency?: SaveUrgency) => void;
  readonly #onModelChanged: () => void;
  readonly #onBrowserChanged: (browserId: string) => void;
  readonly #onNotice: BrowserRuntimeOptions['onNotice'];
  readonly #onExternalUrl: BrowserRuntimeOptions['onExternalUrl'];
  readonly #onNativeBrowserClick: (browserId: string, shiftKey: boolean) => void;
  readonly #onNativeBrowserEscape: (browserId: string) => void;
  readonly #onContentsDestroyed: (contentsId: number) => void;
  readonly #entries = new Map<string, RuntimeEntry>();
  readonly #intentionalCloses = new Set<number>();
  readonly #syncTimers = new Map<string, NodeJS.Timeout>();
  readonly #lastSyncAt = new Map<string, number>();
  readonly #pendingCaptures = new Set<string>();
  // Electron serializes mouse events for 'input-event' without their modifiers, so whether Shift is held during a press
  // inside a page comes from the key events of the shell and of every page instead.
  #shiftHeld = false;
  #disposed = false;

  constructor(options: BrowserRuntimeOptions) {
    this.#window = options.window;
    this.#model = options.model;
    this.#sessions = options.sessions;
    this.#scheduleSave = options.scheduleSave;
    this.#onModelChanged = options.onModelChanged;
    this.#onBrowserChanged = options.onBrowserChanged;
    this.#onNotice = options.onNotice;
    this.#onExternalUrl = options.onExternalUrl;
    this.#onNativeBrowserClick = options.onNativeBrowserClick ?? (() => undefined);
    this.#onNativeBrowserEscape = options.onNativeBrowserEscape ?? (() => undefined);
    this.#onContentsDestroyed = options.onContentsDestroyed ?? (() => undefined);
    this.#window.webContents.on('before-input-event', (_event, input) => this.#trackModifiers(input));
    this.#window.on('blur', () => { this.#shiftHeld = false; });
  }

  /** Creates the selected browser first. Its page loads in the background, so startup never waits for the network. */
  initialize(): void {
    const selectedId = this.#model.selectedBrowserId;
    if (!selectedId || !this.#model.hasBrowser(selectedId) || this.#model.isSuspended(selectedId)) return;
    this.#ensureView(selectedId);
  }

  getRuntimeStates(): Map<string, BrowserRuntimeState> {
    const states = new Map<string, BrowserRuntimeState>();
    for (const [browserId, entry] of this.#entries) states.set(browserId, structuredClone(entry.state));
    return states;
  }

  getRuntimeState(browserId: string): BrowserRuntimeState | undefined {
    const entry = this.#entries.get(browserId);
    return entry ? structuredClone(entry.state) : undefined;
  }

  createBrowser(profileId: string): void {
    this.#assertActive();
    const browser = this.#model.createBrowser(profileId);
    this.#ensureView(browser.id);
    this.#applyNativeOrder();
    this.#scheduleSave();
    this.#onModelChanged();
  }

  closeBrowser(browserId: string): void {
    this.#assertActive();
    this.#requireBrowser(browserId);
    this.#destroyView(browserId);
    this.#model.removeBrowser(browserId);
    this.#scheduleSave();
    this.#onModelChanged();
  }

  duplicateBrowsers(browserIds: readonly string[]): void {
    this.#assertActive();
    for (const browserId of browserIds) this.#captureNavigation(browserId);
    const copies = this.#model.duplicateBrowsers(browserIds);
    for (const copy of copies) this.#ensureView(copy.id);
    this.#applyNativeOrder();
    this.#scheduleSave();
    this.#onModelChanged();
  }

  /** Recreates the view with the target profile's Session. The source profile and its storage are never touched. */
  assignProfile(browserId: string, profileId: string): void {
    this.#assertActive();
    const current = this.#model.getBrowser(browserId);
    if (current.profileId === profileId) return;
    this.#model.getProfile(profileId);
    this.#captureNavigation(browserId);
    this.#destroyView(browserId);
    this.#model.assignProfile(browserId, profileId);
    if (!this.#model.isSuspended(browserId)) this.#ensureView(browserId);
    this.#applyNativeOrder();
    this.#scheduleSave();
    this.#onModelChanged();
  }

  navigate(browserId: string, input: string): void {
    this.#assertActive();
    const normalized = normalizeNavigationInput(input);
    const { entry, woke } = this.#ensureAwakeView(browserId);
    this.#load(entry, normalized);
    this.#afterWake(woke);
  }

  back(browserId: string): void {
    this.#assertActive();
    const { entry, woke } = this.#ensureAwakeView(browserId);
    if (entry.contents.navigationHistory.canGoBack()) {
      entry.navigationToken += 1;
      entry.contents.navigationHistory.goBack();
    }
    this.#afterWake(woke);
  }

  forward(browserId: string): void {
    this.#assertActive();
    const { entry, woke } = this.#ensureAwakeView(browserId);
    if (entry.contents.navigationHistory.canGoForward()) {
      entry.navigationToken += 1;
      entry.contents.navigationHistory.goForward();
    }
    this.#afterWake(woke);
  }

  reload(browserId: string): void {
    this.#assertActive();
    const { entry, woke } = this.#ensureAwakeView(browserId);
    entry.navigationToken += 1;
    const recovering = entry.state.crashed;
    entry.state.crashed = false;
    entry.state.lastError = null;
    entry.contents.reload();
    if (woke) this.#afterWake(woke);
    else if (recovering) this.#onBrowserChanged(browserId);
  }

  stop(browserId: string): void {
    this.#assertActive();
    this.#requireBrowser(browserId);
    const entry = this.#entries.get(browserId);
    if (!entry || entry.contents.isDestroyed()) return;
    entry.contents.stop();
    entry.state.isLoading = false;
    this.#onBrowserChanged(browserId);
  }

  focus(browserId: string, options: { focusContents?: boolean } = {}): void {
    this.#assertActive();
    this.#requireBrowser(browserId);
    if (this.#model.focusBrowser(browserId)) {
      this.#applyNativeOrder();
      this.#scheduleSave();
    }
    const entry = this.#entries.get(browserId);
    if (options.focusContents && entry?.appliedVisible && !entry.contents.isDestroyed()) entry.contents.focus();
  }

  sleep(browserId: string): void {
    this.#assertActive();
    this.#requireBrowser(browserId);
    if (this.#model.isSuspended(browserId)) return;
    this.#captureNavigation(browserId);
    this.#destroyView(browserId);
    this.#model.setSuspended(browserId, true);
    this.#scheduleSave();
    this.#onModelChanged();
  }

  /** Idempotent: repeated wake requests reuse the view created by the first one. */
  wake(browserId: string): void {
    this.#assertActive();
    const { woke } = this.#ensureAwakeView(browserId);
    if (woke) this.#scheduleSave();
    this.#onModelChanged();
  }

  applyLayout(layout: LayoutBatch): void {
    if (this.#disposed) return;
    if (this.#model.commitLayout(layout)) this.#scheduleSave();
    let orderChanged = false;
    for (const item of layout.items) {
      if (!this.#model.hasBrowser(item.browserId)) continue;
      const existing = this.#entries.get(item.browserId);
      const surfaceLayer = item.surfaceLayer ?? 'normal';
      const show = item.visible
        && !this.#model.isSuspended(item.browserId)
        && !existing?.state.crashed
        && this.#isSafeContentBounds(item.screenBounds, surfaceLayer);
      if (!show) {
        if (existing?.appliedVisible) {
          existing.view.setVisible(false);
          existing.appliedVisible = false;
        }
        continue;
      }
      if (!existing) orderChanged = true;
      const entry = existing ?? this.#ensureView(item.browserId);
      if (entry.surfaceLayer !== surfaceLayer) {
        entry.surfaceLayer = surfaceLayer;
        orderChanged = true;
      }
      if (!sameBounds(entry.appliedBounds, item.screenBounds)) {
        entry.view.setBounds(item.screenBounds);
        entry.appliedBounds = { ...item.screenBounds };
      }
      if (!entry.appliedVisible) {
        entry.view.setVisible(true);
        entry.appliedVisible = true;
      }
    }
    if (orderChanged) this.#applyNativeOrder();
  }

  captureAllNavigation(): void {
    for (const browserId of this.#entries.keys()) this.#captureNavigation(browserId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.captureAllNavigation();
    this.#disposed = true;
    for (const timer of this.#syncTimers.values()) clearTimeout(timer);
    this.#syncTimers.clear();
    this.#pendingCaptures.clear();
    for (const browserId of [...this.#entries.keys()]) this.#destroyView(browserId);
    clearFaviconCache();
  }

  #assertActive(): void {
    if (this.#disposed) throw new OmniUserError('conflict', 'OmniBrowser se está cerrando.');
  }

  #requireBrowser(browserId: string): void {
    if (!this.#model.hasBrowser(browserId)) throw new BrowserNotFoundError();
  }

  #ensureAwakeView(browserId: string): { entry: RuntimeEntry; woke: boolean } {
    this.#requireBrowser(browserId);
    const woke = this.#model.setSuspended(browserId, false);
    const hadView = this.#entries.has(browserId);
    const entry = this.#ensureView(browserId);
    if (!hadView) this.#applyNativeOrder();
    return { entry, woke };
  }

  #afterWake(woke: boolean): void {
    if (!woke) return;
    this.#scheduleSave();
    this.#onModelChanged();
  }

  #ensureView(browserId: string): RuntimeEntry {
    const existing = this.#entries.get(browserId);
    if (existing && !existing.contents.isDestroyed()) return existing;
    const record = this.#model.getBrowser(browserId);
    const profileSession = this.#sessions.get(this.#model.getProfile(record.profileId));
    const view = new WebContentsView({ webPreferences: remoteWebPreferences(profileSession) });
    const entry = this.#register(browserId, record.profileId, view, view.webContents, profileSession);
    this.#startRestore(entry, record);
    return entry;
  }

  #register(browserId: string, profileId: string, view: WebContentsView, contents: WebContents, profileSession: Session): RuntimeEntry {
    const entry: RuntimeEntry = {
      view,
      contents,
      contentsId: contents.id,
      state: {
        isAwake: true,
        isLoading: contents.isLoading(),
        canGoBack: false,
        canGoForward: false,
        crashed: false,
        isAudible: false,
        faviconKey: null,
        download: { activeCount: 0, receivedBytes: 0, totalBytes: null, status: 'idle' },
        lastError: null
      },
      navigationToken: 0,
      appliedBounds: null,
      appliedVisible: false,
      surfaceLayer: 'normal',
      unregisterDownload: () => undefined,
      disposed: false
    };
    this.#entries.set(browserId, entry);
    view.setVisible(false);
    this.#window.contentView.addChildView(view);
    entry.unregisterDownload = registerDownloadWebContents(profileSession, contents.id, (download, failed) => {
      if (entry.disposed) return;
      entry.state.download = download;
      entry.state.lastError = failed ? 'download' : entry.state.lastError === 'download' ? null : entry.state.lastError;
      this.#onBrowserChanged(browserId);
    });
    this.#configureContents(browserId, profileId, entry, profileSession);
    return entry;
  }

  #startRestore(entry: RuntimeEntry, record: BrowserRecord): void {
    const history = sanitizeHistory(record.history.entries, record.history.index);
    const fallbackUrl = isPersistableNavigationUrl(record.url) ? record.url : DEFAULT_BROWSER_URL;
    if (history.entries.length === 0) {
      this.#load(entry, fallbackUrl);
      return;
    }
    const token = entry.navigationToken + 1;
    entry.navigationToken = token;
    const isPrivate = this.#model.getProfile(record.profileId).kind === 'private';
    const fallback = () => {
      if (this.#isSuperseded(entry, token)) return;
      this.#onNotice('warning', isPrivate
        ? 'No se pudo restaurar todo el historial de un browser Private; se abrió su última URL.'
        : `No se pudo restaurar todo el historial de “${record.title}”; se abrió su última URL.`);
      this.#load(entry, fallbackUrl);
    };
    let restoring: Promise<void>;
    try {
      restoring = entry.contents.navigationHistory.restore({ entries: history.entries, index: history.index });
    } catch {
      fallback();
      return;
    }
    restoring.catch(() => {
      if (this.#isSuperseded(entry, token)) return;
      // A restored stack whose active page failed to load (offline, refused) is kept: did-fail-load reports the failure.
      if (entry.contents.navigationHistory.length() >= history.entries.length) return;
      fallback();
    });
  }

  #load(entry: RuntimeEntry, url: string): void {
    entry.navigationToken += 1;
    // Electron attaches a no-op rejection handler; failures surface through did-fail-load instead of the IPC caller.
    void entry.contents.loadURL(url);
  }

  #isSuperseded(entry: RuntimeEntry, token: number): boolean {
    return entry.disposed || entry.contents.isDestroyed() || entry.navigationToken !== token;
  }

  #configureContents(browserId: string, profileId: string, entry: RuntimeEntry, profileSession: Session): void {
    const { contents } = entry;
    const isPrivate = this.#model.getProfile(profileId).kind === 'private';
    const guardNavigation = (event: Event, url: string) => {
      if (isAllowedNavigationUrl(url)) return;
      event.preventDefault();
      if (parseExternalUrl(url)) this.#onExternalUrl(url, entry.contentsId);
      else this.#onNotice('warning', isPrivate ? 'Navegación bloqueada en un browser Private.' : `Navegación bloqueada: ${url.slice(0, 180)}`);
    };

    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('did-start-loading', () => {
      entry.state.isLoading = true;
      this.#queueSync(browserId, false);
    });
    contents.on('did-stop-loading', () => {
      entry.state.isLoading = false;
      this.#queueSync(browserId, true);
    });
    contents.on('did-navigate', () => {
      entry.state.crashed = false;
      entry.state.lastError = null;
      this.#queueSync(browserId, true);
    });
    contents.on('did-navigate-in-page', () => this.#queueSync(browserId, true));
    contents.on('page-title-updated', () => this.#queueSync(browserId, true));
    contents.on('audio-state-changed', (event) => {
      entry.state.isAudible = event.audible;
      this.#onBrowserChanged(browserId);
    });
    contents.on('page-favicon-updated', (_event, favicons) => {
      const favicon = favicons.find((value) => value.startsWith('https:') || value.startsWith('http:'));
      if (!favicon) return;
      void captureFavicon(profileSession, favicon).then((key) => {
        if (!key || entry.disposed || this.#entries.get(browserId) !== entry) return;
        entry.state.faviconKey = key;
        this.#onBrowserChanged(browserId);
      });
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === NET_ERROR_ABORTED || entry.disposed) return;
      entry.state.lastError = 'navigation';
      this.#onNotice('warning', isPrivate
        ? 'No se pudo cargar una página en un browser Private.'
        : `No se pudo cargar ${displayDomain(validatedUrl)} (${errorDescription}).`);
      this.#onBrowserChanged(browserId);
    });
    contents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit' || entry.disposed) return;
      entry.state.crashed = true;
      entry.state.isLoading = false;
      entry.state.lastError = 'crashed';
      if (entry.appliedVisible) {
        entry.view.setVisible(false);
        entry.appliedVisible = false;
      }
      this.#onNotice('error', 'Una vista del navegador dejó de responder. Usa Recargar para reactivarla.');
      this.#onBrowserChanged(browserId);
    });
    contents.on('before-input-event', (event, input) => {
      this.#trackModifiers(input);
      if (input.type !== 'keyDown' || input.key !== 'Escape' || entry.surfaceLayer !== 'immersive') return;
      event.preventDefault();
      this.#onNativeBrowserEscape(browserId);
    });
    // Pressing inside a page selects its card. Only native input is used: 'focus' also fires for programmatic focus,
    // lazy view creation and window.focus(), which would let a background page steal the selection.
    contents.on('input-event', (_event, input) => {
      if (input.type === 'mouseDown' || input.type === 'touchStart' || input.type === 'gestureTapDown') {
        this.#onNativeBrowserClick(browserId, this.#shiftHeld || ('modifiers' in input && Boolean(input.modifiers?.includes('shift'))));
        this.#selectFromPage(browserId, entry);
      }
    });
    contents.once('destroyed', () => {
      entry.disposed = true;
      this.#onContentsDestroyed(entry.contentsId);
      if (this.#entries.get(browserId) === entry) {
        this.#entries.delete(browserId);
        this.#cancelSync(browserId);
      }
      if (this.#intentionalCloses.delete(entry.contentsId) || this.#disposed) return;
      if (!this.#model.hasBrowser(browserId)) return;
      // A page-initiated window.close() closes its card, as it would close a browser tab.
      this.#model.removeBrowser(browserId);
      this.#scheduleSave();
      this.#onModelChanged();
    });
    contents.setWindowOpenHandler((details) => {
      if (this.#disposed) return { action: 'deny' };
      if (!isAllowedNavigationUrl(details.url)) {
        if (parseExternalUrl(details.url)) this.#onExternalUrl(details.url, entry.contentsId);
        else this.#onNotice('warning', isPrivate ? 'Ventana emergente bloqueada en un browser Private.' : `Ventana emergente bloqueada: ${details.url.slice(0, 180)}`);
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        // Cards are first-class workspace items: closing, suspending or reassigning the opener must not delete them.
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: remoteWebPreferences(profileSession)
        },
        createWindow: (options) => this.#adoptPopup(browserId, profileId, details.url, options, profileSession)
      };
    });
  }

  #adoptPopup(openerBrowserId: string, profileId: string, url: string, options: BrowserWindowConstructorOptions, expectedSession: Session): WebContents {
    const providedContents = (options as BrowserWindowConstructorOptions & { webContents?: WebContents }).webContents;
    if (!providedContents) throw new Error('Electron did not provide a WebContents for the popup.');
    if (providedContents.session !== expectedSession) throw new Error('Popup session did not match its opener profile.');
    const opener = this.#model.hasBrowser(openerBrowserId) ? this.#model.getBrowser(openerBrowserId) : null;
    const browser = this.#model.createBrowser(profileId, {
      url,
      title: 'Ventana emergente',
      worldRect: opener ? {
        x: opener.worldRect.x + 44,
        y: opener.worldRect.y + 44,
        width: opener.worldRect.width,
        height: opener.worldRect.height
      } : undefined
    });
    const view = new WebContentsView({ webContents: providedContents });
    this.#register(browser.id, profileId, view, providedContents, expectedSession);
    this.#applyNativeOrder();
    this.#scheduleSave();
    setImmediate(() => this.#onModelChanged());
    return providedContents;
  }

  #trackModifiers(input: Input): void {
    if (input.key === 'Shift' && (input.type === 'keyDown' || input.type === 'keyUp')) this.#shiftHeld = input.type === 'keyDown';
  }

  #selectFromPage(browserId: string, entry: RuntimeEntry): void {
    if (this.#disposed || entry.disposed || !this.#model.hasBrowser(browserId)) return;
    if (!this.#model.focusBrowser(browserId)) return;
    this.#applyNativeOrder();
    this.#scheduleSave();
    this.#onModelChanged();
  }

  #queueSync(browserId: string, capture: boolean): void {
    if (this.#disposed) return;
    if (capture) this.#pendingCaptures.add(browserId);
    if (this.#syncTimers.has(browserId)) return;
    const elapsed = Date.now() - (this.#lastSyncAt.get(browserId) ?? 0);
    const delay = Math.max(0, NAVIGATION_SYNC_INTERVAL_MS - elapsed);
    this.#syncTimers.set(browserId, setTimeout(() => this.#flushSync(browserId), delay));
  }

  #flushSync(browserId: string): void {
    this.#syncTimers.delete(browserId);
    this.#lastSyncAt.set(browserId, Date.now());
    const capture = this.#pendingCaptures.delete(browserId);
    const entry = this.#entries.get(browserId);
    if (this.#disposed || !entry || entry.contents.isDestroyed() || !this.#model.hasBrowser(browserId)) return;
    if (capture) {
      const change = this.#captureNavigation(browserId);
      if (change === 'location') this.#scheduleSave('soon');
      else if (change === 'title') this.#scheduleSave('idle');
    }
    entry.state.canGoBack = entry.contents.navigationHistory.canGoBack();
    entry.state.canGoForward = entry.contents.navigationHistory.canGoForward();
    entry.state.isAwake = true;
    this.#onBrowserChanged(browserId);
  }

  #cancelSync(browserId: string): void {
    const timer = this.#syncTimers.get(browserId);
    if (timer) clearTimeout(timer);
    this.#syncTimers.delete(browserId);
    this.#pendingCaptures.delete(browserId);
    this.#lastSyncAt.delete(browserId);
  }

  #captureNavigation(browserId: string): NavigationChange {
    const entry = this.#entries.get(browserId);
    if (!entry || entry.contents.isDestroyed() || !this.#model.hasBrowser(browserId)) return 'none';
    const history = entry.contents.navigationHistory;
    return this.#model.setNavigation(browserId, {
      url: entry.contents.getURL(),
      title: entry.contents.getTitle(),
      history: { entries: history.getAllEntries(), index: history.getActiveIndex() }
    });
  }

  /** Keeps the native stacking order of live views equal to the workspace z-order. */
  #applyNativeOrder(): void {
    if (this.#window.isDestroyed()) return;
    const desired = [...this.#entries.entries()]
      .filter(([browserId]) => this.#model.hasBrowser(browserId))
      .sort(([a, entryA], [b, entryB]) => {
        const layer = { normal: 0, pinned: 1, immersive: 2 } as const;
        return layer[entryA.surfaceLayer] - layer[entryB.surfaceLayer] || this.#model.zIndexOf(a) - this.#model.zIndexOf(b);
      })
      .map(([, entry]) => entry.view);
    const managed = new Set<unknown>(desired);
    const current = this.#window.contentView.children.filter((child) => managed.has(child));
    if (current.length === desired.length && current.every((view, index) => view === desired[index])) return;
    for (const view of desired) this.#window.contentView.addChildView(view);
  }

  #destroyView(browserId: string): void {
    const entry = this.#entries.get(browserId);
    if (!entry) return;
    this.#entries.delete(browserId);
    this.#cancelSync(browserId);
    entry.disposed = true;
    entry.unregisterDownload();
    if (!this.#window.isDestroyed()) this.#window.contentView.removeChildView(entry.view);
    if (entry.contents.isDestroyed()) return;
    this.#intentionalCloses.add(entry.contentsId);
    entry.contents.close({ waitForBeforeUnload: false });
  }

  #isSafeContentBounds(bounds: ScreenRect, layer: RuntimeEntry['surfaceLayer'] = 'normal'): boolean {
    const contentSize = this.#window.getContentSize();
    const width = contentSize[0] ?? 0;
    const height = contentSize[1] ?? 0;
    if (layer === 'immersive') {
      return bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height;
    }
    return bounds.x >= PROFILE_RAIL_WIDTH
      && bounds.y >= TOOLBAR_HEIGHT
      && bounds.x + bounds.width <= width
      && bounds.y + bounds.height <= height - STATUS_BAR_HEIGHT;
  }
}
