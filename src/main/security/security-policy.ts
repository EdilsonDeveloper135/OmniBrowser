import type { App, BrowserWindow, DownloadItem, Session, WebPreferences } from 'electron';
import { dialog, shell } from 'electron';
import type { BrowserRuntimeState } from '../../shared/schemas';
import { parseExternalUrl } from '../../shared/urls';
import type { ExternalOpenGate } from './external-open-gate';

export type SecurityNotice = (message: string) => void;

const sessionNotices = new WeakMap<Session, SecurityNotice>();
const sessionsWithDownloadPolicy = new WeakSet<Session>();
const downloadOwners = new WeakMap<Session, Map<number, DownloadOwner>>();
const MAX_EXTERNAL_URL_PREVIEW = 300;
const DOWNLOAD_PROGRESS_INTERVAL_MS = 100;

interface DownloadOwner {
  items: Set<DownloadItem>;
  onChange: (state: BrowserRuntimeState['download'], failed: boolean) => void;
  pending: { state: BrowserRuntimeState['download']; failed: boolean } | null;
  progressTimer: ReturnType<typeof setTimeout> | null;
}

function downloadState(owner: DownloadOwner, status: BrowserRuntimeState['download']['status'] = owner.items.size > 0 ? 'active' : 'idle'): BrowserRuntimeState['download'] {
  let receivedBytes = 0;
  let totalBytes = 0;
  let hasKnownTotal = true;
  for (const item of owner.items) {
    receivedBytes += Math.max(0, item.getReceivedBytes());
    const total = item.getTotalBytes();
    if (total <= 0) hasKnownTotal = false;
    else totalBytes += total;
  }
  return { activeCount: owner.items.size, receivedBytes, totalBytes: hasKnownTotal ? totalBytes : null, status };
}

function publishDownloadState(owner: DownloadOwner, state: BrowserRuntimeState['download'], failed: boolean, immediate = false): void {
  owner.pending = { state, failed: failed || Boolean(owner.pending?.failed) };
  if (!immediate && owner.progressTimer) return;
  const flush = () => {
    owner.progressTimer = null;
    const pending = owner.pending;
    owner.pending = null;
    if (pending) owner.onChange(pending.state, pending.failed);
  };
  if (immediate) {
    if (owner.progressTimer) clearTimeout(owner.progressTimer);
    flush();
  } else {
    owner.progressTimer = setTimeout(flush, DOWNLOAD_PROGRESS_INTERVAL_MS);
  }
}

export function registerDownloadWebContents(
  profileSession: Session,
  contentsId: number,
  onChange: DownloadOwner['onChange']
): () => void {
  let owners = downloadOwners.get(profileSession);
  if (!owners) {
    owners = new Map();
    downloadOwners.set(profileSession, owners);
  }
  const owner: DownloadOwner = { items: new Set(), onChange, pending: null, progressTimer: null };
  owners.set(contentsId, owner);
  return () => {
    if (owners?.get(contentsId) !== owner) return;
    owners.delete(contentsId);
    if (owner.progressTimer) clearTimeout(owner.progressTimer);
    owner.progressTimer = null;
    owner.pending = null;
    for (const item of owner.items) item.cancel();
    owner.items.clear();
  };
}

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
  profileSession.on('will-download', (event, item, webContents) => {
    const owner = downloadOwners.get(profileSession)?.get(webContents?.id ?? -1);
    if (!owner) {
      event.preventDefault();
      sessionNotices.get(profileSession)?.('Se bloqueó una descarga sin navegador de origen.');
      return;
    }
    item.setSaveDialogOptions({ title: 'Guardar descarga', defaultPath: item.getFilename() });
    owner.items.add(item);
    publishDownloadState(owner, downloadState(owner), false, true);
    item.on('updated', () => publishDownloadState(owner, downloadState(owner), false));
    item.once('done', (_doneEvent, state) => {
      owner.items.delete(item);
      const failed = state === 'interrupted';
      publishDownloadState(owner, downloadState(owner, failed ? 'interrupted' : owner.items.size > 0 ? 'active' : 'idle'), failed, true);
    });
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
