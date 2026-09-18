import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type SecureTextReadResult =
  | { status: 'missing' }
  | { status: 'valid'; source: string }
  | { status: 'invalid'; reason: string };

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${path.basename(directory)} no es un directorio seguro.`);
  await chmod(directory, 0o700);
}

export async function readSecureText(filePath: string, maxBytes: number): Promise<SecureTextReadResult> {
  const name = path.basename(filePath);
  let handle: FileHandle | undefined;
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return { status: 'invalid', reason: `${name} no es un archivo regular.` };
    if (metadata.size > maxBytes) return { status: 'invalid', reason: `${name} supera el límite de tamaño.` };
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    await handle.chmod(0o600);
    const source = await handle.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(source, 'utf8') > maxBytes) return { status: 'invalid', reason: `${name} supera el límite de tamaño.` };
    return { status: 'valid', source };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle?.close();
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // Some filesystems do not support directory fsync. The file is still fsynced before the atomic rename.
  }
}

export async function writeSecureTextAtomically(directory: string, target: string, content: string): Promise<void> {
  await ensurePrivateDirectory(directory);
  const temporaryPath = path.join(directory, `.${path.basename(target)}-${process.pid}-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, target);
    await chmod(target, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await syncDirectoryBestEffort(directory);
}

export async function preserveCorruptFile(filePath: string, now: Date, suffix = randomUUID().slice(0, 8)): Promise<string | null> {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const extension = path.extname(filePath);
  const stem = extension.length > 0 ? filePath.slice(0, -extension.length) : filePath;
  const preservedPath = `${stem}.corrupt-${stamp}-${suffix}${extension}`;
  try {
    await rename(filePath, preservedPath);
    await syncDirectoryBestEffort(path.dirname(filePath));
    return preservedPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
