import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialWorkspace } from '../../src/main/domain/workspace-model';
import { WorkspaceStore } from '../../src/main/persistence/workspace-store';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnibrowser-store-test-'));
  directories.push(directory);
  return directory;
}

describe('WorkspaceStore', () => {
  it('writes and loads a validated atomic workspace file', async () => {
    const directory = await temporaryDirectory();
    const store = new WorkspaceStore(directory);
    const workspace = createInitialWorkspace();
    await store.save(workspace);
    const loaded = await store.load(createInitialWorkspace);
    expect(loaded.recoveredFrom).toBe('primary');
    expect(loaded.workspace).toEqual(workspace);
    expect(JSON.parse(await readFile(store.workspacePath, 'utf8'))).toEqual(workspace);
  });

  it('recovers from backup and preserves the corrupt primary on the next save', async () => {
    const directory = await temporaryDirectory();
    const store = new WorkspaceStore(directory);
    const first = createInitialWorkspace();
    await store.save(first);
    const second = { ...first, camera: { panX: 20, panY: 30, zoom: 1 } };
    await store.save(second);
    await writeFile(store.workspacePath, '{ not-json', 'utf8');

    const recovered = await store.load(createInitialWorkspace);
    expect(recovered.recoveredFrom).toBe('backup');
    expect(recovered.workspace).toEqual(first);
    await store.save(recovered.workspace);

    const files = await readdir(directory);
    expect(files.some((file) => file.startsWith('workspace.corrupt-'))).toBe(true);
    expect((await store.load(createInitialWorkspace)).recoveredFrom).toBe('primary');
  });
});
