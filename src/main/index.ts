import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, screen, session } from 'electron';
import { OmniBrowserController } from './app-controller';
import { registerIpc } from './ipc/register-ipc';
import { installShellProtocol, registerShellScheme, SHELL_SCHEME } from './protocol/shell-protocol';
import { configureRestrictedSession, shellWebPreferences } from './security/security-policy';

registerShellScheme();

function configureE2eUserDataPath(): void {
  const candidate = process.env.OMNIBROWSER_E2E_USER_DATA;
  if (process.env.OMNIBROWSER_E2E !== '1' || !candidate) return;
  const resolved = path.resolve(candidate);
  const relativeToTemporaryDirectory = path.relative(os.tmpdir(), resolved);
  if (relativeToTemporaryDirectory.startsWith('..') || path.isAbsolute(relativeToTemporaryDirectory)) {
    throw new Error('OMNIBROWSER_E2E_USER_DATA must resolve inside the operating-system temporary directory.');
  }
  app.setPath('userData', resolved);
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

configureE2eUserDataPath();

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
    webPreferences: shellWebPreferences(MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY)
  });
  const controller = await OmniBrowserController.create(window);
  restoreWindowBounds(window, controller.snapshot().windowBounds);
  registerIpc(controller);

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url);
    const isDevelopmentEntry = MAIN_WINDOW_WEBPACK_ENTRY.startsWith('http') && url.startsWith(new URL(MAIN_WINDOW_WEBPACK_ENTRY).origin);
    if (parsed.protocol !== `${SHELL_SCHEME}:` && !isDevelopmentEntry) event.preventDefault();
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(await installShellProtocol());
}

app.whenReady().then(async () => {
  await createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
