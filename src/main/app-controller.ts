import { app, BrowserWindow, dialog } from 'electron';
import { browserIdInputSchema, cameraInputSchema, createBrowserInputSchema, createProfileInputSchema, layoutBatchSchema, navigateInputSchema, assignProfileInputSchema, type WorkspaceSnapshot } from '../shared/schemas';
import type { OmniEvent } from '../shared/contracts';
import { BrowserRuntime } from './browser/browser-runtime';
import { createInitialWorkspace, WorkspaceModel } from './domain/workspace-model';
import { SaveScheduler, type SaveStatus } from './lifecycle/save-scheduler';
import { WorkspaceStore } from './persistence/workspace-store';
import { ProfileSessionManager } from './profiles/profile-session-manager';
import { confirmAndOpenExternal } from './security/security-policy';

export class OmniBrowserController {
  readonly window: BrowserWindow;
  readonly #store: WorkspaceStore;
  readonly #model: WorkspaceModel;
  readonly #sessions: ProfileSessionManager;
  readonly #runtime: BrowserRuntime;
  readonly #saveScheduler: SaveScheduler;
  #saveStatus: SaveStatus = 'saved';
  #recoveryWarning?: string;
  #readyToClose = false;
  #shutdownPromise: Promise<void> | null = null;

  private constructor(window: BrowserWindow, store: WorkspaceStore, model: WorkspaceModel, recoveryWarning?: string) {
    this.window = window;
    this.#store = store;
    this.#model = model;
    this.#recoveryWarning = recoveryWarning;
    this.#sessions = new ProfileSessionManager((message) => this.emit({ type: 'notice', level: 'warning', message }));
    this.#saveScheduler = new SaveScheduler(
      () => this.#store.save(this.#model.toPersistentFile()),
      (status) => {
        this.#saveStatus = status;
        this.emit({ type: 'save-status', status });
      }
    );
    this.#runtime = new BrowserRuntime({
      window,
      model,
      sessions: this.#sessions,
      scheduleSave: () => this.#saveScheduler.schedule(),
      onModelChanged: () => this.emitSnapshot(),
      onBrowserChanged: (browserId) => this.emitBrowser(browserId),
      onNotice: (level, message) => this.emit({ type: 'notice', level, message }),
      onExternalUrl: (url) => void confirmAndOpenExternal(this.window, url, (message) => this.emit({ type: 'notice', level: 'warning', message }))
    });
  }

  static async create(window: BrowserWindow): Promise<OmniBrowserController> {
    const store = new WorkspaceStore(app.getPath('userData'));
    const loaded = await store.load(createInitialWorkspace);
    const model = new WorkspaceModel(loaded.workspace);
    const controller = new OmniBrowserController(window, store, model, loaded.warning);
    await controller.#runtime.initialize();
    controller.attachWindowLifecycle();
    if (loaded.recoveredFrom === 'new') controller.#saveScheduler.schedule();
    return controller;
  }

  bootstrap(): WorkspaceSnapshot {
    if (this.#recoveryWarning) {
      const warning = this.#recoveryWarning;
      this.#recoveryWarning = undefined;
      setImmediate(() => this.emit({ type: 'notice', level: 'warning', message: warning }));
    }
    return this.snapshot();
  }

  listProfiles() {
    return this.#model.listProfiles();
  }

  createPersistentProfile(input: unknown): WorkspaceSnapshot {
    const { name } = createProfileInputSchema.parse(input);
    this.#model.createProfile(name, 'persistent');
    this.changed();
    return this.snapshot();
  }

  createTemporaryProfile(input: unknown): WorkspaceSnapshot {
    const { name } = createProfileInputSchema.parse(input);
    this.#model.createProfile(name, 'temporary');
    this.changed();
    return this.snapshot();
  }

  async createBrowser(input: unknown): Promise<WorkspaceSnapshot> {
    const { profileId } = createBrowserInputSchema.parse(input);
    await this.#runtime.createBrowser(profileId);
    return this.snapshot();
  }

  async closeBrowser(input: unknown): Promise<WorkspaceSnapshot> {
    const { browserId } = browserIdInputSchema.parse(input);
    await this.#runtime.closeBrowser(browserId);
    return this.snapshot();
  }

  async assignProfile(input: unknown): Promise<WorkspaceSnapshot> {
    const { browserId, profileId } = assignProfileInputSchema.parse(input);
    const browser = this.#model.getBrowser(browserId);
    if (browser.profileId === profileId) return this.snapshot();
    const from = this.#model.getProfile(browser.profileId);
    const to = this.#model.getProfile(profileId);
    const confirmation = await dialog.showMessageBox(this.window, {
      type: 'warning',
      buttons: ['Cancelar', 'Cambiar perfil'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Cambiar sesión del navegador',
      message: `Cambiar de “${from.name}” a “${to.name}” recreará esta vista.`,
      detail: 'El historial y la URL se conservarán, pero la página usará inmediatamente las cookies y el almacenamiento del perfil de destino.'
    });
    if (confirmation.response === 1) await this.#runtime.assignProfile(browserId, profileId);
    return this.snapshot();
  }

  async navigate(input: unknown): Promise<void> {
    const { browserId, url } = navigateInputSchema.parse(input);
    await this.#runtime.navigate(browserId, url);
  }

  async back(input: unknown): Promise<void> {
    const { browserId } = browserIdInputSchema.parse(input);
    await this.#runtime.back(browserId);
  }

  async forward(input: unknown): Promise<void> {
    const { browserId } = browserIdInputSchema.parse(input);
    await this.#runtime.forward(browserId);
  }

  async reload(input: unknown): Promise<void> {
    const { browserId } = browserIdInputSchema.parse(input);
    await this.#runtime.reload(browserId);
  }

  async focus(input: unknown): Promise<WorkspaceSnapshot> {
    const { browserId } = browserIdInputSchema.parse(input);
    await this.#runtime.focus(browserId);
    return this.snapshot();
  }

  async sleep(input: unknown): Promise<WorkspaceSnapshot> {
    const { browserId } = browserIdInputSchema.parse(input);
    await this.#runtime.sleep(browserId);
    return this.snapshot();
  }

  async wake(input: unknown): Promise<WorkspaceSnapshot> {
    const { browserId } = browserIdInputSchema.parse(input);
    await this.#runtime.wake(browserId);
    return this.snapshot();
  }

  async commitLayout(input: unknown): Promise<void> {
    const layout = layoutBatchSchema.parse(input);
    await this.#runtime.applyLayout(layout);
  }

  setCamera(input: unknown): void {
    const { camera } = cameraInputSchema.parse(input);
    this.#model.setCamera(camera);
    this.#saveScheduler.schedule();
  }

  async saveNow(): Promise<void> {
    await this.#runtime.captureAllNavigation();
    this.#saveScheduler.schedule();
    await this.#saveScheduler.flush();
  }

  snapshot(): WorkspaceSnapshot {
    return this.#model.toSnapshot(this.#runtime.getRuntimeStates(), this.#saveStatus);
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = (async () => {
      await this.#runtime.captureAllNavigation();
      this.#saveScheduler.schedule();
      await this.#saveScheduler.flush();
      await this.#sessions.flushPersistent(this.#model.listProfiles());
      await this.#runtime.dispose();
    })();
    return this.#shutdownPromise;
  }

  private changed(): void {
    this.#saveScheduler.schedule();
    this.emitSnapshot();
  }

  private emitBrowser(browserId: string): void {
    const browser = this.snapshot().browsers.find((candidate) => candidate.id === browserId);
    if (browser) this.emit({ type: 'browser-state', browser });
  }

  private emitSnapshot(): void {
    this.emit({ type: 'workspace-snapshot', snapshot: this.snapshot() });
  }

  private emit(event: OmniEvent): void {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send('omni:event', event);
  }

  private attachWindowLifecycle(): void {
    const persistBounds = () => {
      if (this.window.isDestroyed() || this.window.isMinimized() || this.window.isFullScreen()) return;
      this.#model.setWindowBounds(this.window.getBounds());
      this.#saveScheduler.schedule();
    };
    this.window.on('resize', persistBounds);
    this.window.on('move', persistBounds);
    this.window.on('close', (event) => {
      if (this.#readyToClose) return;
      event.preventDefault();
      void this.shutdown().catch((error) => {
        this.emit({ type: 'notice', level: 'error', message: error instanceof Error ? error.message : String(error) });
      }).finally(() => {
        this.#readyToClose = true;
        if (!this.window.isDestroyed()) this.window.close();
      });
    });
  }
}
