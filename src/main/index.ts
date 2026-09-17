import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, screen, session } from 'electron';
import { OmniBrowserController } from './app-controller';
import { registerIpc } from './ipc/register-ipc';
import { installShellProtocol, registerShellScheme, SHELL_SCHEME } from './protocol/shell-protocol';
import { configureRestrictedSession, installWebContentsGuards, shellWebPreferences } from './security/security-policy';

registerShellScheme();

function configureUserDataPath(): void {
  const candidate = process.env.OMNIBROWSER_E2E_USER_DATA;
  if (process.env.OMNIBROWSER_E2E === '1' && candidate) {
    const resolved = path.resolve(candidate);
    const relativeToTemporaryDirectory = path.relative(os.tmpdir(), resolved);
    if (relativeToTemporaryDirectory.startsWith('..') || path.isAbsolute(relativeToTemporaryDirectory)) {
      throw new Error('OMNIBROWSER_E2E_USER_DATA must resolve inside the operating-system temporary directory.');
    }
    app.setPath('userData', resolved);
    return;
  }
  // Unpackaged runs take their name from package.json ("omnibrowser") and packaged ones from the bundle ("OmniBrowser").
  // On case-insensitive APFS both resolve to the same folder, so development would share real cookies and workspace.json.
  if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'OmniBrowser Development'));
}

function restoreWindowBounds(window: BrowserWindow, bounds: ReturnType<OmniBrowserController['snapshot']>['windowBounds']): void {
  if (!bounds) return;
  const intersectsDisplay = screen.getAllDisplays().some(({ workArea }) => (
    bounds.x < workArea.x + workArea.width
    && bounds.x + bounds.width > workArea.x
    && bounds.y < workArea.y + workArea.height
    && bounds.y + bounds.height > workArea.y
  ));
  if (intersectsDisplay) window.setBounds(bounds, false);
}

configureUserDataPath();

let controller: OmniBrowserController | null = null;
let windowCreation: Promise<void> | null = null;

async function createMainWindow(): Promise<void> {
  configureRestrictedSession(session.defaultSession, () => undefined);
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b1118',
    title: 'OmniBrowser',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    // CI virtual displays are smaller than the 1440×900 window the E2E geometry uses, and macOS would shrink it to the
    // display's work area. Only automated runs may exceed the screen.
    enableLargerThanScreen: process.env.OMNIBROWSER_E2E === '1',
    webPreferences: shellWebPreferences(MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY)
  });
  const nextController = await OmniBrowserController.create(window);
  controller = nextController;
  restoreWindowBounds(window, nextController.snapshot().windowBounds);
  registerIpc(nextController);

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url);
    const isDevelopmentEntry = MAIN_WINDOW_WEBPACK_ENTRY.startsWith('http') && url.startsWith(new URL(MAIN_WINDOW_WEBPACK_ENTRY).origin);
    if (parsed.protocol !== `${SHELL_SCHEME}:` && !isDevelopmentEntry) event.preventDefault();
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(await installShellProtocol());
}

function openMainWindow(): Promise<void> {
  windowCreation ??= createMainWindow().finally(() => {
    windowCreation = null;
  });
  return windowCreation;
}

// One process per userData directory: two instances would race on workspace.json and on Chromium's profile storage.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  installWebContentsGuards(app);

  app.on('second-instance', () => {
    const window = controller?.window;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  // Quit (Cmd+Q, logout, SIGTERM) waits for the controller to persist and release its views, then resumes the quit.
  // Without this, preventing the window close during a quit would cancel it and leave a windowless process running.
  app.on('before-quit', (event) => {
    if (!controller || controller.isShutDown) return;
    event.preventDefault();
    void controller.shutdown().then(() => app.quit());
  });

  app.whenReady().then(async () => {
    await openMainWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void openMainWindow();
    });
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
