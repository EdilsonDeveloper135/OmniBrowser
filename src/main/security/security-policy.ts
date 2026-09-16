import type { BrowserWindow, Session, WebPreferences } from 'electron';
import { dialog, shell } from 'electron';
import { parseExternalUrl } from '../../shared/urls';

export type SecurityNotice = (message: string) => void;

const sessionNotices = new WeakMap<Session, SecurityNotice>();
const sessionsWithDownloadPolicy = new WeakSet<Session>();

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
  profileSession.setUSBProtectedClassesHandler(() => []);
  if (sessionsWithDownloadPolicy.has(profileSession)) return;
  sessionsWithDownloadPolicy.add(profileSession);
  profileSession.on('will-download', (event) => {
    event.preventDefault();
    sessionNotices.get(profileSession)?.('Las descargas están deshabilitadas en este MVP.');
  });
}

export async function confirmAndOpenExternal(parent: BrowserWindow, value: string, notice: SecurityNotice): Promise<void> {
  const parsed = parseExternalUrl(value);
  if (!parsed) {
    notice('OmniBrowser bloqueó un protocolo externo no permitido.');
    return;
  }
  const result = await dialog.showMessageBox(parent, {
    type: 'question',
    buttons: ['Cancelar', 'Abrir'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Abrir aplicación externa',
    message: `¿Quieres abrir ${parsed.protocol} fuera de OmniBrowser?`,
    detail: parsed.toString()
  });
  if (result.response !== 1) return;
  await shell.openExternal(parsed.toString(), { activate: true });
}
