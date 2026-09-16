import { constants } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceFileSchema, type WorkspaceFile } from '../../shared/schemas';

const MAX_WORKSPACE_BYTES = 10 * 1024 * 1024;

export interface WorkspaceLoadResult {
  workspace: WorkspaceFile;
  recoveredFrom: 'primary' | 'backup' | 'new';
  warning?: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export class WorkspaceStore {
  readonly directory: string;
  readonly workspacePath: string;
  readonly backupPath: string;
  #preservePrimaryOnNextSave = false;

  constructor(directory: string) {
    this.directory = directory;
    this.workspacePath = path.join(directory, 'workspace.json');
    this.backupPath = path.join(directory, 'workspace.backup.json');
  }

  async load(createDefault: () => WorkspaceFile): Promise<WorkspaceLoadResult> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const primary = await this.tryRead(this.workspacePath);
    if (primary.ok) return { workspace: primary.value, recoveredFrom: 'primary' };

    const backup = await this.tryRead(this.backupPath);
    if (backup.ok) {
      this.#preservePrimaryOnNextSave = await exists(this.workspacePath);
      return {
        workspace: backup.value,
        recoveredFrom: 'backup',
        warning: `workspace.json no era válido; se recuperó ${path.basename(this.backupPath)}.`
      };
    }

    return {
      workspace: workspaceFileSchema.parse(createDefault()),
      recoveredFrom: 'new',
      warning: primary.reason || backup.reason ? 'No se encontró un workspace válido; se creó uno nuevo sin borrar los archivos anteriores.' : undefined
    };
  }

  async save(workspace: WorkspaceFile): Promise<void> {
    const validated = workspaceFileSchema.parse(workspace);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(this.directory, `.workspace-${process.pid}-${randomUUID()}.tmp`);

    if (await exists(this.workspacePath)) {
      if (this.#preservePrimaryOnNextSave) {
        const corruptPath = path.join(this.directory, `workspace.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        await rename(this.workspacePath, corruptPath);
        this.#preservePrimaryOnNextSave = false;
      } else {
        await copyFile(this.workspacePath, this.backupPath);
      }
    }

    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.workspacePath);
    await this.syncDirectoryBestEffort();
  }

  private async tryRead(filePath: string): Promise<{ ok: true; value: WorkspaceFile } | { ok: false; reason?: string }> {
    try {
      const metadata = await stat(filePath);
      if (metadata.size > MAX_WORKSPACE_BYTES) return { ok: false, reason: `${path.basename(filePath)} supera el límite de tamaño.` };
      const source = await readFile(filePath, 'utf8');
      return { ok: true, value: workspaceFileSchema.parse(JSON.parse(source)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false };
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async syncDirectoryBestEffort(): Promise<void> {
    try {
      const directoryHandle = await open(this.directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch {
      // Directory fsync support varies. The file itself is already fsynced and renamed atomically.
    }
  }
}
