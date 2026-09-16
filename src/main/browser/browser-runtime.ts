import type { BrowserWindowConstructorOptions, Event, Session, WebContents } from 'electron';
import { BrowserWindow, WebContentsView } from 'electron';
import {
  PROFILE_RAIL_WIDTH,
  STATUS_BAR_HEIGHT,
  TOOLBAR_HEIGHT
} from '../../shared/constants';
import type {
  BrowserRecord,
  BrowserRuntimeState,
  LayoutBatch,
  NavigationHistoryRecord,
  ScreenRect
} from '../../shared/schemas';
import { isAllowedNavigationUrl, normalizeNavigationInput, parseExternalUrl } from '../../shared/urls';
import { WorkspaceModel } from '../domain/workspace-model';
import { ProfileSessionManager } from '../profiles/profile-session-manager';
import { remoteWebPreferences } from '../security/security-policy';

interface RuntimeEntry {
  view: WebContentsView;
  contents: WebContents;
  state: BrowserRuntimeState;
}

interface BrowserRuntimeOptions {
  window: BrowserWindow;
  model: WorkspaceModel;
  sessions: ProfileSessionManager;
  scheduleSave: () => void;
  onModelChanged: () => void;
  onBrowserChanged: (browserId: string) => void;
  onNotice: (level: 'info' | 'warning' | 'error', message: string) => void;
  onExternalUrl: (url: string) => void;
}

const sleepingState = (record: BrowserRecord): BrowserRuntimeState => ({
  isAwake: false,
  isLoading: false,
  canGoBack: record.history.index > 0,
  canGoForward: record.history.entries.length > 0 && record.history.index < record.history.entries.length - 1,
  crashed: false
});

export class BrowserRuntime {
  readonly #window: BrowserWindow;
  readonly #model: WorkspaceModel;
  readonly #sessions: ProfileSessionManager;
  readonly #scheduleSave: () => void;
  readonly #onModelChanged: () => void;
  readonly #onBrowserChanged: (browserId: string) => void;
  readonly #onNotice: BrowserRuntimeOptions['onNotice'];
  readonly #onExternalUrl: BrowserRuntimeOptions['onExternalUrl'];
  readonly #entries = new Map<string, RuntimeEntry>();
  readonly #pendingCreates = new Map<string, Promise<RuntimeEntry>>();
  readonly #intentionalCloses = new Set<number>();

  constructor(options: BrowserRuntimeOptions) {
    this.#window = options.window;
    this.#model = options.model;
    this.#sessions = options.sessions;
    this.#scheduleSave = options.scheduleSave;
    this.#onModelChanged = options.onModelChanged;
    this.#onBrowserChanged = options.onBrowserChanged;
    this.#onNotice = options.onNotice;
    this.#onExternalUrl = options.onExternalUrl;
  }

  async initialize(): Promise<void> {
    const selectedId = this.#model.selectedBrowserId;
    if (!selectedId || !this.#model.hasBrowser(selectedId)) return;
    const browser = this.#model.getBrowser(selectedId);
    if (!browser.suspended) await this.ensureView(selectedId);
  }

  getRuntimeStates(): Map<string, BrowserRuntimeState> {
    const states = new Map<string, BrowserRuntimeState>();
    for (const record of this.#model.listBrowsers()) {
      const entry = this.#entries.get(record.id);
      states.set(record.id, entry ? { ...entry.state } : sleepingState(record));
    }
    return states;
  }

  async createBrowser(profileId: string): Promise<BrowserRecord> {
    const browser = this.#model.createBrowser(profileId);
    await this.ensureView(browser.id);
    this.#scheduleSave();
    this.#onModelChanged();
    return browser;
  }

  async closeBrowser(browserId: string): Promise<void> {
    await this.destroyView(browserId);
    this.#model.removeBrowser(browserId);
    this.#scheduleSave();
    this.#onModelChanged();
  }

  async assignProfile(browserId: string, profileId: string): Promise<void> {
    const current = this.#model.getBrowser(browserId);
    if (current.profileId === profileId) return;
    await this.captureNavigation(browserId);
    await this.destroyView(browserId);
    const updated = this.#model.assignProfile(browserId, profileId);
    if (!updated.suspended) await this.ensureView(browserId);
    this.#scheduleSave();
    this.#onModelChanged();
  }

  async navigate(browserId: string, input: string): Promise<void> {
    const normalized = normalizeNavigationInput(input);
    const record = this.#model.getBrowser(browserId);
    if (record.suspended) this.#model.setSuspended(browserId, false);
    const entry = await this.ensureView(browserId);
    await entry.contents.loadURL(normalized);
  }

  async back(browserId: string): Promise<void> {
    const entry = await this.ensureView(browserId);
    if (entry.contents.navigationHistory.canGoBack()) entry.contents.navigationHistory.goBack();
  }

  async forward(browserId: string): Promise<void> {
    const entry = await this.ensureView(browserId);
    if (entry.contents.navigationHistory.canGoForward()) entry.contents.navigationHistory.goForward();
  }

  async reload(browserId: string): Promise<void> {
    const entry = await this.ensureView(browserId);
    entry.contents.reload();
  }

  async focus(browserId: string): Promise<void> {
    this.#model.focusBrowser(browserId);
    const entry = this.#entries.get(browserId);
    if (entry) this.#window.contentView.addChildView(entry.view);
    this.#scheduleSave();
  }

  async sleep(browserId: string): Promise<void> {
    const record = this.#model.getBrowser(browserId);
    if (record.suspended) return;
    await this.captureNavigation(browserId);
    await this.destroyView(browserId);
    this.#model.setSuspended(browserId, true);
    this.#scheduleSave();
    this.#onModelChanged();
  }

  async wake(browserId: string): Promise<void> {
    this.#model.setSuspended(browserId, false);
    await this.ensureView(browserId);
    this.#scheduleSave();
    this.#onModelChanged();
  }

  async applyLayout(layout: LayoutBatch): Promise<void> {
    this.#model.commitLayout(layout);
    await Promise.all(layout.items.map(async (item) => {
      if (!this.#model.hasBrowser(item.browserId)) return;
      const record = this.#model.getBrowser(item.browserId);
      if (!item.visible || record.suspended || !this.isSafeContentBounds(item.screenBounds)) {
        this.#entries.get(item.browserId)?.view.setVisible(false);
        return;
      }
      const entry = await this.ensureView(item.browserId);
      entry.view.setBounds(item.screenBounds);
      entry.view.setVisible(true);
    }));
    this.#scheduleSave();
  }

  async captureAllNavigation(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((browserId) => this.captureNavigation(browserId)));
  }

  async dispose(): Promise<void> {
    await this.captureAllNavigation();
    for (const browserId of [...this.#entries.keys()]) await this.destroyView(browserId);
  }

  private async ensureView(browserId: string): Promise<RuntimeEntry> {
    const pending = this.#pendingCreates.get(browserId);
    if (pending) return pending;
    const existing = this.#entries.get(browserId);
    if (existing) return existing;
    const creation = this.createView(browserId);
    this.#pendingCreates.set(browserId, creation);
    try {
      return await creation;
    } finally {
      this.#pendingCreates.delete(browserId);
    }
  }

  private async createView(browserId: string): Promise<RuntimeEntry> {
    const record = this.#model.getBrowser(browserId);
    const profile = this.#model.getProfile(record.profileId);
    const profileSession = this.#sessions.get(profile);
    const view = new WebContentsView({ webPreferences: remoteWebPreferences(profileSession) });
    const entry: RuntimeEntry = {
      view,
      contents: view.webContents,
      state: { isAwake: true, isLoading: false, canGoBack: false, canGoForward: false, crashed: false }
    };
    this.#entries.set(browserId, entry);
    this.#window.contentView.addChildView(view);
    view.setVisible(false);
    this.configureContents(browserId, entry, profileSession);
    await this.restoreNavigation(browserId, entry);
    this.updateRuntimeHistoryState(browserId);
    return entry;
  }

  private configureContents(browserId: string, entry: RuntimeEntry, profileSession: Session): void {
    const { contents } = entry;
    const guardNavigation = (event: Event, url: string) => {
      if (isAllowedNavigationUrl(url)) return;
      event.preventDefault();
      if (parseExternalUrl(url)) this.#onExternalUrl(url);
      else this.#onNotice('warning', `Navegación bloqueada: ${url.slice(0, 180)}`);
    };

    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('did-start-loading', () => {
      entry.state.isLoading = true;
      this.#onBrowserChanged(browserId);
    });
    contents.on('did-stop-loading', () => {
      entry.state.isLoading = false;
      void this.syncNavigationFromContents(browserId);
    });
    contents.on('did-navigate', () => void this.syncNavigationFromContents(browserId));
    contents.on('did-navigate-in-page', () => void this.syncNavigationFromContents(browserId));
    contents.on('page-title-updated', () => void this.syncNavigationFromContents(browserId));
    contents.on('render-process-gone', () => {
      entry.state.crashed = true;
      entry.state.isLoading = false;
      this.#onNotice('error', 'Una vista del navegador dejó de responder y puede reactivarse con Recargar.');
      this.#onBrowserChanged(browserId);
    });
    contents.once('destroyed', () => {
      if (this.#entries.get(browserId) === entry) this.#entries.delete(browserId);
      if (this.#intentionalCloses.delete(contents.id)) return;
      if (this.#model.hasBrowser(browserId)) {
        this.#model.removeBrowser(browserId);
        this.#scheduleSave();
        this.#onModelChanged();
      }
    });
    contents.setWindowOpenHandler((details) => {
      if (!isAllowedNavigationUrl(details.url)) {
        if (parseExternalUrl(details.url)) this.#onExternalUrl(details.url);
        else this.#onNotice('warning', `Ventana emergente bloqueada: ${details.url.slice(0, 180)}`);
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: remoteWebPreferences(profileSession)
        },
        createWindow: (options) => this.adoptPopup(browserId, details.url, options, profileSession)
      };
    });
  }

  private adoptPopup(openerBrowserId: string, url: string, options: BrowserWindowConstructorOptions, expectedSession: Session): WebContents {
    const providedContents = (options as BrowserWindowConstructorOptions & { webContents?: WebContents }).webContents;
    if (!providedContents) throw new Error('Electron did not provide a WebContents for the popup.');
    if (providedContents.session !== expectedSession) throw new Error('Popup session did not match its opener profile.');
    const opener = this.#model.getBrowser(openerBrowserId);
    const browser = this.#model.createBrowser(opener.profileId, {
      url,
      title: 'Ventana emergente',
      worldRect: {
        x: opener.worldRect.x + 44,
        y: opener.worldRect.y + 44,
        width: opener.worldRect.width,
        height: opener.worldRect.height
      }
    });
    const view = new WebContentsView({ webContents: providedContents });
    const entry: RuntimeEntry = {
      view,
      contents: providedContents,
      state: { isAwake: true, isLoading: true, canGoBack: false, canGoForward: false, crashed: false }
    };
    this.#entries.set(browser.id, entry);
    this.#window.contentView.addChildView(view);
    view.setVisible(false);
    this.configureContents(browser.id, entry, expectedSession);
    this.#scheduleSave();
    setImmediate(() => this.#onModelChanged());
    return providedContents;
  }

  private async restoreNavigation(browserId: string, entry: RuntimeEntry): Promise<void> {
    const record = this.#model.getBrowser(browserId);
    const safeEntries = record.history.entries.filter((historyEntry) => isAllowedNavigationUrl(historyEntry.url));
    if (safeEntries.length > 0) {
      try {
        await entry.contents.navigationHistory.restore({
          entries: safeEntries.map(({ url, title }) => ({ url, title })),
          index: Math.min(record.history.index, safeEntries.length - 1)
        });
        return;
      } catch {
        this.#onNotice('warning', `No se pudo restaurar todo el historial de “${record.title}”; se abrió su última URL.`);
      }
    }
    await entry.contents.loadURL(isAllowedNavigationUrl(record.url) ? record.url : 'about:blank');
  }

  private async captureNavigation(browserId: string): Promise<void> {
    const entry = this.#entries.get(browserId);
    if (!entry || entry.contents.isDestroyed() || !this.#model.hasBrowser(browserId)) return;
    const history = this.sanitizedHistory(entry.contents);
    const currentUrl = entry.contents.getURL();
    const safeUrl = isAllowedNavigationUrl(currentUrl) ? currentUrl : this.#model.getBrowser(browserId).url;
    this.#model.setNavigation(browserId, {
      url: safeUrl,
      title: entry.contents.getTitle() || this.#model.getBrowser(browserId).title,
      history
    });
  }

  private async syncNavigationFromContents(browserId: string): Promise<void> {
    await this.captureNavigation(browserId);
    this.updateRuntimeHistoryState(browserId);
    this.#scheduleSave();
    this.#onBrowserChanged(browserId);
  }

  private sanitizedHistory(contents: WebContents): NavigationHistoryRecord {
    const activeIndex = contents.navigationHistory.getActiveIndex();
    const entries = contents.navigationHistory.getAllEntries();
    const sanitized: NavigationHistoryRecord['entries'] = [];
    let sanitizedIndex = 0;
    entries.forEach((entry, index) => {
      if (!isAllowedNavigationUrl(entry.url)) return;
      sanitized.push({ url: entry.url, title: entry.title.slice(0, 512) });
      if (index <= activeIndex) sanitizedIndex = sanitized.length - 1;
    });
    const firstRetainedIndex = Math.max(0, sanitized.length - 500);
    const retainedEntries = sanitized.slice(firstRetainedIndex);
    return {
      entries: retainedEntries,
      index: Math.max(0, Math.min(sanitizedIndex - firstRetainedIndex, retainedEntries.length - 1))
    };
  }

  private updateRuntimeHistoryState(browserId: string): void {
    const entry = this.#entries.get(browserId);
    if (!entry || entry.contents.isDestroyed()) return;
    entry.state.canGoBack = entry.contents.navigationHistory.canGoBack();
    entry.state.canGoForward = entry.contents.navigationHistory.canGoForward();
    entry.state.isAwake = true;
  }

  private async destroyView(browserId: string): Promise<void> {
    const entry = this.#entries.get(browserId);
    if (!entry) return;
    this.#entries.delete(browserId);
    this.#intentionalCloses.add(entry.contents.id);
    try { this.#window.contentView.removeChildView(entry.view); } catch {}
    if (!entry.contents.isDestroyed()) entry.contents.close({ waitForBeforeUnload: false });
  }

  private isSafeContentBounds(bounds: ScreenRect): boolean {
    const contentSize = this.#window.getContentSize();
    const width = contentSize[0] ?? 0;
    const height = contentSize[1] ?? 0;
    return bounds.x >= PROFILE_RAIL_WIDTH
      && bounds.y >= TOOLBAR_HEIGHT
      && bounds.x + bounds.width <= width
      && bounds.y + bounds.height <= height - STATUS_BAR_HEIGHT;
  }
}
