import type { App, BrowserWindow, Session, WebPreferences } from 'electron';
import { dialog, shell } from 'electron';
import { parseExternalUrl } from '../../shared/urls';
import type { ExternalOpenGate } from './external-open-gate';

export type SecurityNotice = (message: string) => void;

const sessionNotices = new WeakMap<Session, SecurityNotice>();
const sessionsWithDownloadPolicy = new WeakSet<Session>();
const MAX_EXTERNAL_URL_PREVIEW = 300;

export function remoteWebPreferences(profileSession: Session): WebPreferences {
  return {
    session: profileSession,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    backgroundThrottling: true,
    enableWebSQL: false,
    // JavaScript dialogs are window-modal in Electron; this lets the user stop a page that loops alert().
    safeDialogs: true,
    safeDialogsMessage: 'Impedir que esta página abra más diálogos',
    devTools: !process.env.NODE_ENV || process.env.NODE_ENV === 'development'
  };
}

export function shellWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    backgroundThrottling: true,
    enableWebSQL: false,
    devTools: !process.env.NODE_ENV || process.env.NODE_ENV === 'development'
  };
}

export function configureRestrictedSession(profileSession: Session, notice: SecurityNotice): void {
  sessionNotices.set(profileSession, notice);
  profileSession.setPermissionCheckHandler(() => false);
  profileSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    sessionNotices.get(profileSession)?.(`Permiso bloqueado por la política del MVP: ${permission}.`);
    callback(false);
  });
  profileSession.setDevicePermissionHandler(() => false);
  profileSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  // Returning the received list keeps Chromium's default protected USB classes; an empty array would unprotect all of them.
  profileSession.setUSBProtectedClassesHandler((details) => details.protectedClasses);
  if (sessionsWithDownloadPolicy.has(profileSession)) return;
  sessionsWithDownloadPolicy.add(profileSession);
  profileSession.on('will-download', (event) => {
    event.preventDefault();
    sessionNotices.get(profileSession)?.('Las descargas están deshabilitadas en este MVP.');
  });
}

/** Defense in depth for every WebContents, including ones created before OmniBrowser configures them. */
export function installWebContentsGuards(electronApp: App): void {
  electronApp.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (attachEvent) => attachEvent.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

export async function confirmAndOpenExternal(parent: BrowserWindow, value: string, sourceId: number, gate: ExternalOpenGate, notice: SecurityNotice): Promise<void> {
  const parsed = parseExternalUrl(value);
  if (!parsed) {
    notice('OmniBrowser bloqueó un protocolo externo no permitido.');
    return;
  }
  if (!gate.tryAcquire(sourceId)) {
    notice('Se ignoraron aperturas externas repetidas de una página.');
    return;
  }
  try {
    const target = parsed.toString();
    const result = await dialog.showMessageBox(parent, {
      type: 'question',
      buttons: ['Cancelar', 'Abrir'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Abrir aplicación externa',
      message: `¿Quieres abrir ${parsed.protocol} fuera de OmniBrowser?`,
      detail: target.length > MAX_EXTERNAL_URL_PREVIEW ? `${target.slice(0, MAX_EXTERNAL_URL_PREVIEW)}…` : target
    });
    if (result.response === 1) await shell.openExternal(target, { activate: true });
  } finally {
    gate.release(sourceId);
  }
}
