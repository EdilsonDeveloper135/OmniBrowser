import { beforeEach, describe, expect, it, vi } from 'vitest';

let nextContentsId = 100;

class MockWebContents {
  id = nextContentsId++;
  #destroyed = false;
  #url = 'about:blank';
  #title = 'OmniBrowser';
  #listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  navigationHistory = {
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
    getEntryAtIndex: vi.fn(),
    getAllEntries: vi.fn(() => [{ url: 'https://example.com', title: 'Example' }]),
    getActiveIndex: vi.fn(() => 0),
    length: 1,
    currentIndex: 0
  };

  isDestroyed() { return this.#destroyed; }
  close() { this.#destroyed = true; }
  loadURL = vi.fn(async (url: string) => { this.#url = url; });
  stop = vi.fn();
  reload = vi.fn();
  focus = vi.fn();
  getURL() { return this.#url; }
  getTitle() { return this.#title; }
  isLoading() { return false; }
  isAudioMuted() { return false; }
  setAudioMuted = vi.fn();
  setWindowOpenHandler = vi.fn();

  on(event: string, fn: (...args: unknown[]) => void) {
    (this.#listeners[event] ??= []).push(fn);
    return this;
  }
  once(event: string, fn: (...args: unknown[]) => void) {
    const wrapper = (...args: unknown[]) => {
      this.removeListener(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }
  removeListener(event: string, fn: (...args: unknown[]) => void) {
    const list = this.#listeners[event];
    if (list) {
      this.#listeners[event] = list.filter((f) => f !== fn);
    }
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of [...(this.#listeners[event] ?? [])]) {
      fn(...args);
    }
  }
}

class MockWebContentsView {
  webContents = new MockWebContents();
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  visible = true;
  backgroundColor = '';

  setBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => {
    this.bounds = bounds;
  });
  setVisible = vi.fn((visible: boolean) => {
    this.visible = visible;
  });
  setBackgroundColor = vi.fn((color: string) => {
    this.backgroundColor = color;
  });
}

class MockBrowserWindow {
  webContents = new MockWebContents();
  #listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  contentView = {
    children: [] as MockWebContentsView[],
    addChildView: vi.fn((view: MockWebContentsView) => {
      this.contentView.children.push(view);
    }),
    removeChildView: vi.fn((view: MockWebContentsView) => {
      this.contentView.children = this.contentView.children.filter((v) => v !== view);
    })
  };

  isDestroyed = vi.fn(() => false);
  getContentSize = vi.fn(() => [1920, 1080]);

  on(event: string, fn: (...args: unknown[]) => void) {
    (this.#listeners[event] ??= []).push(fn);
    return this;
  }
}

vi.mock('electron', () => {
  return {
    BrowserWindow: MockBrowserWindow,
    WebContentsView: MockWebContentsView
  };
});

const { BrowserRuntime } = await import('../../src/main/browser/browser-runtime');
const { WorkspaceModel, createInitialWorkspace } = await import('../../src/main/domain/workspace-model');
import type { SaveUrgency } from '../../src/main/lifecycle/save-scheduler';
import type { ProfileSessionManager } from '../../src/main/profiles/profile-session-manager';

describe('BrowserRuntime', () => {
  let windowMock: MockBrowserWindow;
  let model: InstanceType<typeof WorkspaceModel>;
  let sessionsMock: ProfileSessionManager;
  let scheduleSaveMock: ReturnType<typeof vi.fn<(urgency?: SaveUrgency) => void>>;
  let onModelChangedMock: ReturnType<typeof vi.fn<() => void>>;
  let onBrowserChangedMock: ReturnType<typeof vi.fn<(browserId: string) => void>>;
  let onNoticeMock: ReturnType<typeof vi.fn<(level: 'info' | 'warning' | 'error', message: string) => void>>;
  let onExternalUrlMock: ReturnType<typeof vi.fn<(url: string, sourceContentsId: number) => void>>;

  beforeEach(() => {
    windowMock = new MockBrowserWindow();
    model = new WorkspaceModel(createInitialWorkspace());
    scheduleSaveMock = vi.fn<(urgency?: SaveUrgency) => void>();
    onModelChangedMock = vi.fn<() => void>();
    onBrowserChangedMock = vi.fn<(browserId: string) => void>();
    onNoticeMock = vi.fn<(level: 'info' | 'warning' | 'error', message: string) => void>();
    onExternalUrlMock = vi.fn<(url: string, sourceContentsId: number) => void>();

    const mockSession = {
      webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() },
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      setUSBProtectedClassesHandler: vi.fn(),
      on: vi.fn(),
      fetch: vi.fn()
    };

    sessionsMock = {
      get: vi.fn(() => mockSession)
    } as unknown as ProfileSessionManager;
  });

  function createRuntime() {
    return new BrowserRuntime({
      window: windowMock as unknown as Electron.BrowserWindow,
      model,
      sessions: sessionsMock,
      scheduleSave: scheduleSaveMock,
      onModelChanged: onModelChangedMock,
      onBrowserChanged: onBrowserChangedMock,
      onNotice: onNoticeMock,
      onExternalUrl: onExternalUrlMock
    });
  }

  it('initializes and creates a WebContentsView for the default selected browser', () => {
    const runtime = createRuntime();
    runtime.initialize();

    expect(windowMock.contentView.children.length).toBe(1);
    const selectedId = model.selectedBrowserId!;
    expect(runtime.getRuntimeState(selectedId)).toBeDefined();
    runtime.dispose();
  });

  it('creates a new browser, attaches view, and triggers save/change notifications', () => {
    const runtime = createRuntime();
    const defaultProfile = model.listProfiles()[0]!;
    const initialCount = model.listBrowsers().length;

    runtime.createBrowser(defaultProfile.id);

    expect(model.listBrowsers().length).toBe(initialCount + 1);
    expect(scheduleSaveMock).toHaveBeenCalled();
    expect(onModelChangedMock).toHaveBeenCalled();
    expect(windowMock.contentView.addChildView).toHaveBeenCalled();

    runtime.dispose();
  });

  it('closes a browser, cleans up view and removes from model', () => {
    const runtime = createRuntime();
    runtime.initialize();

    const browserId = model.selectedBrowserId!;
    runtime.closeBrowser(browserId);

    expect(model.hasBrowser(browserId)).toBe(false);
    expect(runtime.getRuntimeState(browserId)).toBeUndefined();
    expect(windowMock.contentView.removeChildView).toHaveBeenCalled();
    expect(scheduleSaveMock).toHaveBeenCalled();
    expect(onModelChangedMock).toHaveBeenCalled();

    runtime.dispose();
  });

  it('applies layout by updating view bounds and visibility', () => {
    const runtime = createRuntime();
    runtime.initialize();

    const browserId = model.selectedBrowserId!;
    runtime.applyLayout({
      items: [
        {
          browserId,
          worldRect: { x: 0, y: 0, width: 800, height: 600 },
          screenBounds: { x: 300, y: 80, width: 800, height: 600 },
          visible: true,
          surfaceLayer: 'normal'
        }
      ]
    });

    const childView = windowMock.contentView.children[0];
    expect(childView).toBeDefined();
    expect(childView?.setBounds).toHaveBeenCalledWith({ x: 300, y: 80, width: 800, height: 600 });
    expect(childView?.setVisible).toHaveBeenCalledWith(true);

    runtime.dispose();
  });

  it('assigns browser to a different profile, recreating the view with new session', () => {
    const runtime = createRuntime();
    runtime.initialize();

    const browserId = model.selectedBrowserId!;
    const newProfile = model.createProfile('Work Profile', 'persistent');

    runtime.assignProfile(browserId, newProfile.id);

    const browser = model.getBrowser(browserId);
    expect(browser.profileId).toBe(newProfile.id);
    expect(sessionsMock.get).toHaveBeenCalledWith(expect.objectContaining({ id: newProfile.id }));
    expect(onModelChangedMock).toHaveBeenCalled();

    runtime.dispose();
  });

  it('navigates browser to normalized URL', () => {
    const runtime = createRuntime();
    runtime.initialize();

    const browserId = model.selectedBrowserId!;
    runtime.navigate(browserId, 'https://example.org');

    const childView = windowMock.contentView.children[0]!;
    expect(childView.webContents.loadURL).toHaveBeenCalledWith('https://example.org/');

    runtime.dispose();
  });

  it('sleep suspends browser, captures navigation, and destroys WebContentsView', () => {
    const runtime = createRuntime();
    runtime.initialize();

    const browserId = model.selectedBrowserId!;
    expect(windowMock.contentView.children.length).toBe(1);

    runtime.sleep(browserId);

    expect(model.isSuspended(browserId)).toBe(true);
    expect(windowMock.contentView.children.length).toBe(0);
    expect(scheduleSaveMock).toHaveBeenCalled();
    expect(onModelChangedMock).toHaveBeenCalled();

    // Repeated sleep on already suspended browser is a no-op
    scheduleSaveMock.mockClear();
    runtime.sleep(browserId);
    expect(scheduleSaveMock).not.toHaveBeenCalled();

    runtime.dispose();
  });

  it('wake restores a suspended browser and reattaches view', () => {
    const runtime = createRuntime();
    runtime.initialize();

    const browserId = model.selectedBrowserId!;
    runtime.sleep(browserId);
    expect(windowMock.contentView.children.length).toBe(0);

    runtime.wake(browserId);

    expect(model.isSuspended(browserId)).toBe(false);
    expect(windowMock.contentView.children.length).toBe(1);
    expect(scheduleSaveMock).toHaveBeenCalled();

    // Repeated wake is idempotent
    scheduleSaveMock.mockClear();
    runtime.wake(browserId);
    expect(windowMock.contentView.children.length).toBe(1);

    runtime.dispose();
  });

  it('back and forward trigger navigation history actions when allowed', () => {
    const runtime = createRuntime();
    runtime.initialize();

    const browserId = model.selectedBrowserId!;
    const view = windowMock.contentView.children[0]!;

    view.webContents.navigationHistory.canGoBack.mockReturnValue(true);
    runtime.back(browserId);
    expect(view.webContents.navigationHistory.goBack).toHaveBeenCalledTimes(1);

    view.webContents.navigationHistory.canGoForward.mockReturnValue(true);
    runtime.forward(browserId);
    expect(view.webContents.navigationHistory.goForward).toHaveBeenCalledTimes(1);

    runtime.dispose();
  });

  it('reload resets crashed state and reloads content', () => {
    const runtime = createRuntime();
    runtime.initialize();

    const browserId = model.selectedBrowserId!;
    const view = windowMock.contentView.children[0]!;

    view.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(runtime.getRuntimeState(browserId)?.crashed).toBe(true);

    runtime.reload(browserId);

    expect(runtime.getRuntimeState(browserId)?.crashed).toBe(false);
    expect(view.webContents.reload).toHaveBeenCalledTimes(1);
    expect(onBrowserChangedMock).toHaveBeenCalledWith(browserId);

    runtime.dispose();
  });

  it('stop halts page loading and updates runtime state', () => {
    const runtime = createRuntime();
    runtime.initialize();

    const browserId = model.selectedBrowserId!;
    const view = windowMock.contentView.children[0]!;

    runtime.stop(browserId);

    expect(view.webContents.stop).toHaveBeenCalledTimes(1);
    expect(runtime.getRuntimeState(browserId)?.isLoading).toBe(false);
    expect(onBrowserChangedMock).toHaveBeenCalledWith(browserId);

    runtime.dispose();
  });

  it('focus selects browser in model and focuses WebContents when visible', () => {
    const runtime = createRuntime();
    runtime.initialize();

    const browserId = model.selectedBrowserId!;
    const view = windowMock.contentView.children[0]!;

    // Apply layout so view is appliedVisible within safe content area (x >= 240, y >= 40)
    runtime.applyLayout({
      items: [
        {
          browserId,
          worldRect: { x: 0, y: 0, width: 800, height: 600 },
          screenBounds: { x: 300, y: 100, width: 800, height: 600 },
          visible: true
        }
      ]
    });

    runtime.focus(browserId, { focusContents: true });

    expect(model.selectedBrowserId).toBe(browserId);
    expect(view.webContents.focus).toHaveBeenCalledTimes(1);

    runtime.dispose();
  });

  it('throws when operating on non-existent browser id', () => {
    const runtime = createRuntime();
    runtime.initialize();

    expect(() => runtime.sleep('non-existent-id')).toThrow('El navegador ya no existe.');
    expect(() => runtime.stop('non-existent-id')).toThrow('El navegador ya no existe.');
    expect(() => runtime.navigate('non-existent-id', 'https://example.com')).toThrow('El navegador ya no existe.');

    runtime.dispose();
  });

  it('throws assertion error when calling methods after disposal', () => {
    const runtime = createRuntime();
    runtime.initialize();
    runtime.dispose();

    expect(() => runtime.createBrowser('default')).toThrow('OmniBrowser se está cerrando.');
    expect(() => runtime.sleep('any-id')).toThrow('OmniBrowser se está cerrando.');
    expect(() => runtime.wake('any-id')).toThrow('OmniBrowser se está cerrando.');
  });

  it('properly cleans up on dispose', () => {
    const runtime = createRuntime();
    runtime.initialize();

    expect(windowMock.contentView.children.length).toBeGreaterThan(0);
    runtime.dispose();

    expect(windowMock.contentView.children.length).toBe(0);
    // Calling applyLayout after dispose should be a no-op
    runtime.applyLayout({ items: [] });
  });
});
