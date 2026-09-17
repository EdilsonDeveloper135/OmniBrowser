import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORKSPACE_SCHEMA_VERSION } from '../../shared/constants';
import { workspaceFileSchema, type WorkspaceFile } from '../../shared/schemas';
import { sanitizeHistory } from '../domain/navigation-history';
import { migrateWorkspace, WorkspaceVersionError } from './workspace-migrations';

export const MAX_WORKSPACE_BYTES = 10 * 1024 * 1024;
// Per-browser history caps tried, in order, when a workspace would not fit the read limit.
const HISTORY_BUDGET_STEPS = [200, 100, 50, 20, 5, 1] as const;
const TEMPORARY_FILE_PATTERN = /^\.workspace(?:\.backup)?-(\d+)-[0-9a-f-]{36}\.tmp$/;

export interface WorkspaceLoadResult {
  workspace: WorkspaceFile;
  recoveredFrom: 'primary' | 'backup' | 'new';
  warning?: string;
}

export type WorkspaceSaveResult = 'written' | 'unchanged';

type Candidate =
  | { status: 'missing' }
  | { status: 'valid'; workspace: WorkspaceFile; source: string; sourceVersion: number }
  | { status: 'invalid'; reason: string; futureVersion: number | null };

interface PendingPreservation {
  source: string;
  target: string;
}

function format(workspace: WorkspaceFile): string {
  return `${JSON.stringify(workspace, null, 2)}\n`;
}

/**
 * Serializes a validated workspace. If the result would exceed the size that `load()` accepts, older history is trimmed
 * around each active entry until it fits, so the store can never write a file it would later refuse to read.
 */
export function serializeWorkspace(workspace: WorkspaceFile, maxBytes = MAX_WORKSPACE_BYTES): string {
  const validated = workspaceFileSchema.parse(workspace);
  const serialized = format(validated);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return serialized;
  for (const historyLimit of HISTORY_BUDGET_STEPS) {
    const trimmed = format({
      ...validated,
      browsers: validated.browsers.map((browser) => ({
        ...browser,
        history: sanitizeHistory(browser.history.entries, browser.history.index, historyLimit)
      }))
    });
    if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) return trimmed;
  }
  throw new Error('El workspace supera el límite de tamaño incluso después de recortar el historial.');
}

async function readCandidate(filePath: string): Promise<Candidate> {
  const name = path.basename(filePath);
  let handle: FileHandle | undefined;
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile()) return { status: 'invalid', reason: `${name} no es un archivo regular.`, futureVersion: null };
    if (metadata.size > MAX_WORKSPACE_BYTES) return { status: 'invalid', reason: `${name} supera el límite de tamaño.`, futureVersion: null };
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const source = await handle.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(source, 'utf8') > MAX_WORKSPACE_BYTES) {
      return { status: 'invalid', reason: `${name} supera el límite de tamaño.`, futureVersion: null };
    }
    const raw = JSON.parse(source) as unknown;
    const sourceVersion = typeof raw === 'object' && raw !== null && 'schemaVersion' in raw && typeof raw.schemaVersion === 'number'
      ? raw.schemaVersion
      : WORKSPACE_SCHEMA_VERSION;
    const workspace = workspaceFileSchema.parse(migrateWorkspace(raw));
    return { status: 'valid', workspace, source, sourceVersion };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    const futureVersion = error instanceof WorkspaceVersionError ? error.futureVersion : null;
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error), futureVersion };
  } finally {
    await handle?.close();
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch {
    // Directory fsync support varies. The file itself is already fsynced and renamed atomically.
  }
}

async function writeFileAtomically(directory: string, target: string, content: string): Promise<void> {
  const temporaryPath = path.join(directory, `.${path.basename(target, '.json')}-${process.pid}-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, target);
  } catch (error) {
    // Best-effort cleanup of our own temporary file; the original error is what the caller needs.
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await syncDirectoryBestEffort(directory);
}

export class WorkspaceStore {
  readonly directory: string;
  readonly workspacePath: string;
  readonly backupPath: string;
  #pendingPreservations: PendingPreservation[] = [];
  // Content of the last valid primary known to be on disk; it becomes the backup on the next write.
  #lastValidPrimary: string | null = null;
  #backupContent: string | null = null;
  #legacyBackup: { content: string; version: number } | null = null;

  constructor(directory: string) {
    this.directory = directory;
    this.workspacePath = path.join(directory, 'workspace.json');
    this.backupPath = path.join(directory, 'workspace.backup.json');
  }

  async load(createDefault: () => WorkspaceFile): Promise<WorkspaceLoadResult> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.#removeStaleTemporaryFiles();
    this.#pendingPreservations = [];
    this.#legacyBackup = null;

    const primary = await readCandidate(this.workspacePath);
    if (primary.status === 'valid') {
      this.#lastValidPrimary = primary.source;
      if (primary.sourceVersion < WORKSPACE_SCHEMA_VERSION) this.#legacyBackup = { content: primary.source, version: primary.sourceVersion };
      return { workspace: primary.workspace, recoveredFrom: 'primary' };
    }

    const notes: string[] = [];
    if (primary.status === 'invalid') notes.push(this.#schedulePreservation(this.workspacePath, primary));

    const backup = await readCandidate(this.backupPath);
    if (backup.status === 'valid') {
      this.#lastValidPrimary = backup.source;
      this.#backupContent = backup.source;
      if (backup.sourceVersion < WORKSPACE_SCHEMA_VERSION) this.#legacyBackup = { content: backup.source, version: backup.sourceVersion };
      if (primary.status === 'missing') notes.push('No se encontró workspace.json.');
      notes.push('Se recuperó workspace.backup.json.');
      return { workspace: backup.workspace, recoveredFrom: 'backup', warning: notes.join(' ') };
    }
    if (backup.status === 'invalid') notes.push(this.#schedulePreservation(this.backupPath, backup));

    return {
      workspace: workspaceFileSchema.parse(createDefault()),
      recoveredFrom: 'new',
      warning: notes.length > 0 ? `${notes.join(' ')} Se abrió un workspace nuevo.` : undefined
    };
  }

  async save(workspace: WorkspaceFile): Promise<WorkspaceSaveResult> {
    const serialized = serializeWorkspace(workspace);
    if (serialized === this.#lastValidPrimary && this.#pendingPreservations.length === 0 && this.#legacyBackup === null) return 'unchanged';
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.#writeLegacyBackup();
    await this.#preservePendingFiles();
    if (this.#lastValidPrimary !== null && this.#lastValidPrimary !== this.#backupContent) {
      await writeFileAtomically(this.directory, this.backupPath, this.#lastValidPrimary);
      this.#backupContent = this.#lastValidPrimary;
    }
    await writeFileAtomically(this.directory, this.workspacePath, serialized);
    this.#lastValidPrimary = serialized;
    return 'written';
  }

  async #writeLegacyBackup(): Promise<void> {
    const pending = this.#legacyBackup;
    if (!pending) return;
    const target = path.join(this.directory, `workspace.v${pending.version}-backup.json`);
    try {
      await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFileAtomically(this.directory, target, pending.content);
    }
    this.#legacyBackup = null;
  }

  #schedulePreservation(source: string, candidate: Extract<Candidate, { status: 'invalid' }>): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const kind = candidate.futureVersion === null ? 'corrupt' : `future-v${candidate.futureVersion}`;
    const target = path.join(this.directory, `${path.basename(source, '.json')}.${kind}-${stamp}-${randomUUID().slice(0, 8)}.json`);
    this.#pendingPreservations.push({ source, target });
    const reason = candidate.futureVersion === null
      ? `${path.basename(source)} no era válido (${candidate.reason})`
      : `${path.basename(source)} fue creado por una versión más reciente de OmniBrowser (esquema ${candidate.futureVersion})`;
    return `${reason}; se conservará sin cambios como ${path.basename(target)} antes del próximo guardado.`;
  }

  async #preservePendingFiles(): Promise<void> {
    for (const pending of this.#pendingPreservations) {
      try {
        await lstat(pending.source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      await rename(pending.source, pending.target);
    }
    this.#pendingPreservations = [];
    await syncDirectoryBestEffort(this.directory);
  }

  async #removeStaleTemporaryFiles(): Promise<void> {
    const entries = await readdir(this.directory);
    await Promise.all(entries.map(async (entry) => {
      const match = TEMPORARY_FILE_PATTERN.exec(entry);
      if (!match || Number(match[1]) === process.pid) return;
      await unlink(path.join(this.directory, entry)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }));
  }
}
