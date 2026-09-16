import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() }, shell: { openExternal: vi.fn() } }));

const { configureRestrictedSession, remoteWebPreferences, shellWebPreferences } = await import('../../src/main/security/security-policy');

type Handler = (...args: unknown[]) => unknown;

function fakeSession() {
  const handlers: Record<string, Handler> = {};
  const listeners: Record<string, Handler[]> = {};
  const session = {
    setPermissionCheckHandler: (handler: Handler) => { handlers.permissionCheck = handler; },
    setPermissionRequestHandler: (handler: Handler) => { handlers.permissionRequest = handler; },
    setDevicePermissionHandler: (handler: Handler) => { handlers.devicePermission = handler; },
    setDisplayMediaRequestHandler: (handler: Handler) => { handlers.displayMedia = handler; },
    setUSBProtectedClassesHandler: (handler: Handler) => { handlers.usbProtectedClasses = handler; },
    on: (event: string, listener: Handler) => { (listeners[event] ??= []).push(listener); }
  };
  return { session, handlers, listeners };
}

describe('remote content preferences', () => {
  it('keeps every remote WebContents sandboxed, isolated, without Node.js, preload or webview, and throttled', () => {
    const profileSession = {} as Electron.Session;
    const preferences = remoteWebPreferences(profileSession);
    expect(preferences).toMatchObject({
      session: profileSession,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: true,
      safeDialogs: true
    });
    expect(preferences.preload).toBeUndefined();
    expect(preferences).not.toHaveProperty('experimentalFeatures');
    expect(preferences).not.toHaveProperty('enableBlinkFeatures');
  });

  it('gives the shell its preload but the same isolation guarantees', () => {
    expect(shellWebPreferences('/preload.js')).toMatchObject({ preload: '/preload.js', nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false });
  });
});

describe('restricted profile sessions', () => {
  it('denies permissions, devices and screen capture, keeps USB classes protected and cancels downloads', () => {
    const notices: string[] = [];
    const { session, handlers, listeners } = fakeSession();
    configureRestrictedSession(session as unknown as Electron.Session, (message) => notices.push(message));

    for (const permission of ['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'bluetooth', 'clipboard-read', 'fullscreen', 'pointerLock', 'display-capture', 'openExternal']) {
      expect(handlers.permissionCheck?.({}, permission), permission).toBe(false);
      const callback = vi.fn();
      handlers.permissionRequest?.({}, permission, callback);
      expect(callback).toHaveBeenCalledWith(false);
    }
    expect(handlers.devicePermission?.({ deviceType: 'hid' })).toBe(false);
    const displayCallback = vi.fn();
    handlers.displayMedia?.({}, displayCallback);
    expect(displayCallback).toHaveBeenCalledWith({});

    const defaults = ['audio', 'audio-video', 'hid', 'mass-storage', 'smart-card', 'video', 'wireless'];
    expect(handlers.usbProtectedClasses?.({ protectedClasses: defaults })).toEqual(defaults);

    const downloadEvent = { preventDefault: vi.fn() };
    for (const listener of listeners['will-download'] ?? []) listener(downloadEvent);
    expect(downloadEvent.preventDefault).toHaveBeenCalled();
    expect(notices.some((message) => message.includes('descargas'))).toBe(true);
  });

  it('registers the download guard only once per session', () => {
    const { session, listeners } = fakeSession();
    configureRestrictedSession(session as unknown as Electron.Session, () => undefined);
    configureRestrictedSession(session as unknown as Electron.Session, () => undefined);
    expect(listeners['will-download']).toHaveLength(1);
  });
});
