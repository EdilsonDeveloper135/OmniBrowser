import { app, BrowserWindow, dialog } from 'electron';
import {
  assignProfileInputSchema,
  browserIdInputSchema,
  browserIdsInputSchema,
  cameraInputSchema,
  createStackInputSchema,
  createBrowserInputSchema,
  createProfileInputSchema,
  createZoneInputSchema,
  focusInputSchema,
  layoutBatchSchema,
  navigateInputSchema,
  selectStackMemberInputSchema,
  setBrowserOrderInputSchema,
  setPositionLockedInputSchema,
  setPreferencesInputSchema,
  setPresentationInputSchema,
  setSidebarPinnedInputSchema,
  setViewportPinInputSchema,
  setZoneCollapsedInputSchema,
  stackIdInputSchema,
  updateZoneInputSchema,
  assignZoneInputSchema,
  addStackMemberInputSchema,
  zoneIdInputSchema,
  type ProfileRecord,
  type WorkspaceSnapshot
} from '../shared/schemas';
import type { OmniEvent } from '../shared/contracts';
import { BrowserRuntime } from './browser/browser-runtime';
import { createInitialWorkspace, WorkspaceModel } from './domain/workspace-model';
import { parseInput } from './ipc/ipc-result';
import { SaveScheduler, type SaveStatus } from './lifecycle/save-scheduler';
import { WorkspaceStore } from './persistence/workspace-store';
import { ProfileSessionManager } from './profiles/profile-session-manager';
import { ExternalOpenGate } from './security/external-open-gate';
import { confirmAndOpenExternal } from './security/security-policy';

type NoticeLevel = Extract<OmniEvent, { type: 'notice' }>['level'];

// Identical notices (for example repeated permission requests from one page) are shown at most once per window.
const NOTICE_DEDUPLICATION_MS = 4000;

export class OmniBrowserController {
  readonly window: BrowserWindow;
  readonly #store: WorkspaceStore;
  readonly #model: WorkspaceModel;
  readonly #sessions: ProfileSessionManager;
  readonly #runtime: BrowserRuntime;
  readonly #saveScheduler: SaveScheduler;
  readonly #externalOpenGate = new ExternalOpenGate();
  readonly #recentNotices = new Map<string, number>();
  #saveStatus: SaveStatus = 'saved';
  #recoveryWarning?: string;
  #shutdownPromise: Promise<void> | null = null;
  #shutdownComplete = false;

  private constructor(window: BrowserWindow, store: WorkspaceStore, model: WorkspaceModel, recoveryWarning?: string) {
    this.window = window;
    this.#store = store;
    this.#model = model;
    this.#recoveryWarning = recoveryWarning;
    this.#sessions = new ProfileSessionManager((message) => this.#notice('warning', message));
    this.#saveScheduler = new SaveScheduler(
      () => this.#store.save(this.#model.toPersistentFile()),
      (status) => {
        if (status === this.#saveStatus) return;
        this.#saveStatus = status;
        this.#emit({ type: 'save-status', status });
      },
      { onError: (error) => console.error('[omnibrowser] No se pudo guardar el workspace:', error) }
    );
    this.#runtime = new BrowserRuntime({
      window,
      model,
      sessions: this.#sessions,
      scheduleSave: (urgency) => this.#saveScheduler.schedule(urgency),
      onModelChanged: () => this.#emitSnapshot(),
      onBrowserChanged: (browserId) => this.#emitBrowser(browserId),
      onNotice: (level, message) => this.#notice(level, message),
      onExternalUrl: (url, sourceContentsId) => {
        void confirmAndOpenExternal(this.window, url, sourceContentsId, this.#externalOpenGate, (message) => this.#notice('warning', message));
      },
      onNativeBrowserClick: (browserId, shiftKey) => this.#emit({ type: 'native-browser-click', browserId, shiftKey }),
      onNativeBrowserEscape: (browserId) => this.#emit({ type: 'native-browser-escape', browserId }),
      onContentsDestroyed: (contentsId) => this.#externalOpenGate.forget(contentsId)
    });
  }

  static async create(window: BrowserWindow): Promise<OmniBrowserController> {
    const store = new WorkspaceStore(app.getPath('userData'));
    const loaded = await store.load(createInitialWorkspace);
    const model = new WorkspaceModel(loaded.workspace);
    const controller = new OmniBrowserController(window, store, model, loaded.warning);
    controller.#runtime.initialize();
    controller.#attachWindowLifecycle();
    // A recovered or new workspace is written promptly so that damaged files are preserved and a valid primary exists.
    if (loaded.recoveredFrom !== 'primary') controller.#saveScheduler.schedule();
    return controller;
  }

  get isShutDown(): boolean {
    return this.#shutdownComplete;
  }

  bootstrap(): WorkspaceSnapshot {
    if (this.#recoveryWarning) {
      const warning = this.#recoveryWarning;
      this.#recoveryWarning = undefined;
      setImmediate(() => this.#notice('warning', warning));
    }
    return this.snapshot();
  }

  listProfiles(): ProfileRecord[] {
    return this.#model.listProfiles();
  }

  createPersistentProfile(input: unknown): WorkspaceSnapshot {
    const { name } = parseInput(createProfileInputSchema, input);
    this.#model.createProfile(name, 'persistent');
    this.#changed();
    return this.snapshot();
  }

  createPrivateProfile(input: unknown): WorkspaceSnapshot {
    const { name } = parseInput(createProfileInputSchema, input);
    this.#model.createProfile(name, 'private');
    this.#changed();
    return this.snapshot();
  }

  createBrowser(input: unknown): WorkspaceSnapshot {
    const { profileId } = parseInput(createBrowserInputSchema, input);
    this.#runtime.createBrowser(profileId);
    return this.snapshot();
  }

  closeBrowser(input: unknown): WorkspaceSnapshot {
    const { browserId } = parseInput(browserIdInputSchema, input);
    this.#runtime.closeBrowser(browserId);
    return this.snapshot();
  }

  duplicateBrowsers(input: unknown): WorkspaceSnapshot {
    const { browserIds } = parseInput(browserIdsInputSchema, input);
    this.#runtime.duplicateBrowsers(browserIds);
    return this.snapshot();
  }

  setPresentation(input: unknown): WorkspaceSnapshot {
    const { browserIds, presentation } = parseInput(setPresentationInputSchema, input);
    this.#model.setPresentation(browserIds, presentation);
    this.#changed();
    return this.snapshot();
  }

  setPositionLocked(input: unknown): WorkspaceSnapshot {
    const { browserIds, locked } = parseInput(setPositionLockedInputSchema, input);
    this.#model.setPositionLocked(browserIds, locked);
    this.#changed();
    return this.snapshot();
  }

  setSidebarPinned(input: unknown): WorkspaceSnapshot {
    const { browserIds, pinned } = parseInput(setSidebarPinnedInputSchema, input);
    this.#model.setSidebarPinned(browserIds, pinned);
    this.#changed();
    return this.snapshot();
  }

  setViewportPin(input: unknown): WorkspaceSnapshot {
    const { browserId, viewport } = parseInput(setViewportPinInputSchema, input);
    this.#model.setViewportPin(browserId, viewport);
    this.#changed();
    return this.snapshot();
  }

  async assignProfile(input: unknown): Promise<WorkspaceSnapshot> {
    const { browserId, profileId } = parseInput(assignProfileInputSchema, input);
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
      detail: from.kind === to.kind
        ? 'El historial y la URL se conservarán, pero se perderá el estado no guardado de la página y la vista usará inmediatamente la sesión del perfil de destino.'
        : 'Al cruzar el límite Private/Persistent sólo se conservará la URL actual. El historial, las cookies, el almacenamiento, los formularios y el desplazamiento no se transferirán.'
    });
    if (confirmation.response === 1) this.#runtime.assignProfile(browserId, profileId);
    return this.snapshot();
  }

  navigate(input: unknown): void {
    const { browserId, url } = parseInput(navigateInputSchema, input);
    this.#runtime.navigate(browserId, url);
  }

  back(input: unknown): void {
    const { browserId } = parseInput(browserIdInputSchema, input);
    this.#runtime.back(browserId);
  }

  forward(input: unknown): void {
    const { browserId } = parseInput(browserIdInputSchema, input);
    this.#runtime.forward(browserId);
  }

  reload(input: unknown): void {
    const { browserId } = parseInput(browserIdInputSchema, input);
    this.#runtime.reload(browserId);
  }

  stop(input: unknown): void {
    const { browserId } = parseInput(browserIdInputSchema, input);
    this.#runtime.stop(browserId);
  }

  focus(input: unknown): WorkspaceSnapshot {
    const { browserId, focusContents } = parseInput(focusInputSchema, input);
    this.#runtime.focus(browserId, { focusContents });
    return this.snapshot();
  }

  sleep(input: unknown): WorkspaceSnapshot {
    const { browserId } = parseInput(browserIdInputSchema, input);
    this.#runtime.sleep(browserId);
    return this.snapshot();
  }

  wake(input: unknown): WorkspaceSnapshot {
    const { browserId } = parseInput(browserIdInputSchema, input);
    this.#runtime.wake(browserId);
    return this.snapshot();
  }

  clearFocus(): WorkspaceSnapshot {
    if (this.#model.clearFocus()) this.#changed();
    return this.snapshot();
  }

  createZone(input: unknown): WorkspaceSnapshot {
    const { profileId, name, color, browserIds } = parseInput(createZoneInputSchema, input);
    this.#model.createZone(profileId, name, color, browserIds);
    this.#changed();
    return this.snapshot();
  }

  updateZone(input: unknown): WorkspaceSnapshot {
    const { zoneId, name, color } = parseInput(updateZoneInputSchema, input);
    this.#model.updateZone(zoneId, { name, color });
    this.#changed();
    return this.snapshot();
  }

  setZoneCollapsed(input: unknown): WorkspaceSnapshot {
    const { zoneId, collapsed } = parseInput(setZoneCollapsedInputSchema, input);
    this.#model.setZoneCollapsed(zoneId, collapsed);
    this.#changed();
    return this.snapshot();
  }

  deleteZone(input: unknown): WorkspaceSnapshot {
    const { zoneId } = parseInput(zoneIdInputSchema, input);
    this.#model.deleteZone(zoneId);
    this.#changed();
    return this.snapshot();
  }

  assignZone(input: unknown): WorkspaceSnapshot {
    const { browserIds, zoneId } = parseInput(assignZoneInputSchema, input);
    this.#model.assignZone(browserIds, zoneId);
    this.#changed();
    return this.snapshot();
  }

  createStack(input: unknown): WorkspaceSnapshot {
    const { zoneId, browserIds } = parseInput(createStackInputSchema, input);
    this.#model.createStack(zoneId, browserIds);
    this.#changed();
    return this.snapshot();
  }

  addStackMember(input: unknown): WorkspaceSnapshot {
    const { stackId, browserId } = parseInput(addStackMemberInputSchema, input);
    this.#model.addStackMember(stackId, browserId);
    this.#changed();
    return this.snapshot();
  }

  selectStackMember(input: unknown): WorkspaceSnapshot {
    const { stackId, browserId } = parseInput(selectStackMemberInputSchema, input);
    this.#model.selectStackMember(stackId, browserId);
    this.#changed();
    return this.snapshot();
  }

  unstack(input: unknown): WorkspaceSnapshot {
    const { stackId } = parseInput(stackIdInputSchema, input);
    this.#model.unstack(stackId);
    this.#changed();
    return this.snapshot();
  }

  setBrowserOrder(input: unknown): WorkspaceSnapshot {
    const { browserOrder } = parseInput(setBrowserOrderInputSchema, input);
    this.#model.setBrowserOrder(browserOrder);
    this.#changed();
    return this.snapshot();
  }

  setPreferences(input: unknown): WorkspaceSnapshot {
    const update = parseInput(setPreferencesInputSchema, input);
    this.#model.setPreferences(update);
    this.#changed();
    return this.snapshot();
  }

  commitLayout(input: unknown): void {
    this.#runtime.applyLayout(parseInput(layoutBatchSchema, input));
  }

  setCamera(input: unknown): void {
    const { camera } = parseInput(cameraInputSchema, input);
    if (this.#model.setCamera(camera)) this.#saveScheduler.schedule();
  }

  async saveNow(): Promise<void> {
    this.#runtime.captureAllNavigation();
    this.#saveScheduler.schedule();
    await this.#saveScheduler.flush();
  }

  snapshot(): WorkspaceSnapshot {
    return this.#model.toSnapshot(this.#runtime.getRuntimeStates(), this.#saveStatus);
  }

  /** Idempotent and never rejects: each step runs even if a previous one failed, so one error cannot skip the rest. */
  shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#performShutdown();
    return this.#shutdownPromise;
  }

  async #performShutdown(): Promise<void> {
    const steps: ReadonlyArray<readonly [string, () => void | Promise<void>]> = [
      ['capturar la navegación', () => this.#runtime.captureAllNavigation()],
      ['guardar el workspace', async () => {
        this.#saveScheduler.schedule();
        await this.#saveScheduler.flush();
      }],
      ['vaciar el almacenamiento de los perfiles', () => this.#sessions.flushPersistent(this.#model.listProfiles())],
      ['liberar las vistas', () => this.#runtime.dispose()],
      ['limpiar las sesiones privadas', () => this.#sessions.clearPrivate(this.#model.listProfiles())]
    ];
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (error) {
        console.error(`[omnibrowser] No se pudo ${label} durante el cierre:`, error);
      }
    }
    this.#saveScheduler.dispose();
    this.#shutdownComplete = true;
  }

  #changed(): void {
    this.#saveScheduler.schedule();
    this.#emitSnapshot();
  }

  #emitBrowser(browserId: string): void {
    if (!this.#model.hasBrowser(browserId)) return;
    this.#emit({ type: 'browser-state', browser: this.#model.toBrowserSnapshot(browserId, this.#runtime.getRuntimeState(browserId)) });
  }

  #emitSnapshot(): void {
    this.#emit({ type: 'workspace-snapshot', snapshot: this.snapshot() });
  }

  #notice(level: NoticeLevel, message: string): void {
    const key = `${level}:${message}`;
    const now = Date.now();
    if (now - (this.#recentNotices.get(key) ?? Number.NEGATIVE_INFINITY) < NOTICE_DEDUPLICATION_MS) return;
    this.#recentNotices.set(key, now);
    for (const [candidate, shownAt] of this.#recentNotices) {
      if (now - shownAt >= NOTICE_DEDUPLICATION_MS) this.#recentNotices.delete(candidate);
    }
    this.#emit({ type: 'notice', level, message });
  }

  #emit(event: OmniEvent): void {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send('omni:event', event);
  }

  #attachWindowLifecycle(): void {
    const persistBounds = () => {
      if (this.window.isDestroyed() || this.window.isMinimized() || this.window.isFullScreen()) return;
      if (this.#model.setWindowBounds(this.window.getBounds())) this.#saveScheduler.schedule('idle');
    };
    this.window.on('resize', persistBounds);
    this.window.on('move', persistBounds);
    this.window.on('close', (event) => {
      if (this.#shutdownComplete) return;
      event.preventDefault();
      void this.shutdown().then(() => {
        if (!this.window.isDestroyed()) this.window.close();
      });
    });
  }
}
