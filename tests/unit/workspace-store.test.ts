import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialWorkspace } from '../../src/main/domain/workspace-model';
import { migrateWorkspace, WorkspaceVersionError } from '../../src/main/persistence/workspace-migrations';
import { MAX_WORKSPACE_BYTES, serializeWorkspace, WorkspaceStore } from '../../src/main/persistence/workspace-store';
import type { WorkspaceFile } from '../../src/shared/schemas';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnibrowser-store-test-'));
  directories.push(directory);
  return directory;
}

async function filesIn(directory: string): Promise<Record<string, string>> {
  const names = await readdir(directory);
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(path.join(directory, name), 'utf8')] as const)));
}

function withHistory(workspace: WorkspaceFile, entries: number, urlLength: number): WorkspaceFile {
  return {
    ...workspace,
    browsers: workspace.browsers.map((browser) => ({
      ...browser,
      history: {
        entries: Array.from({ length: entries }, (_, index) => ({ url: `https://example.com/${index}/${'p'.repeat(urlLength)}`, title: `Entry ${index}` })),
        index: entries - 1
      }
    }))
  };
}

function asLegacyV1(workspace: WorkspaceFile): Record<string, unknown> {
  const legacyWorkspace = structuredClone(workspace) as unknown as Record<string, unknown>;
  legacyWorkspace.schemaVersion = 1;
  delete legacyWorkspace.zones;
  delete legacyWorkspace.stacks;
  delete legacyWorkspace.browserOrder;
  delete legacyWorkspace.preferences;
  legacyWorkspace.browsers = workspace.browsers.map((browser) => {
    const legacyBrowser = structuredClone(browser) as unknown as Record<string, unknown>;
    delete legacyBrowser.zoneId;
    delete legacyBrowser.presentation;
    delete legacyBrowser.positionLocked;
    delete legacyBrowser.pin;
    return legacyBrowser;
  });
  return legacyWorkspace;
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

  it('creates one immutable V1 recovery copy before the first V2 write', async () => {
    const directory = await temporaryDirectory();
    const store = new WorkspaceStore(directory);
    const legacy = `${JSON.stringify(asLegacyV1(createInitialWorkspace()), null, 2)}\n`;
    await writeFile(store.workspacePath, legacy, 'utf8');

    const loaded = await store.load(createInitialWorkspace);
    expect(loaded.recoveredFrom).toBe('primary');
    expect(loaded.workspace.schemaVersion).toBe(2);
    expect(await store.save(loaded.workspace)).toBe('written');
    const recoveryPath = path.join(directory, 'workspace.v1-backup.json');
    expect(await readFile(recoveryPath, 'utf8')).toBe(legacy);
    expect((await lstat(recoveryPath)).mode & 0o777).toBe(0o600);

    await writeFile(recoveryPath, 'existing recovery copy', 'utf8');
    const reopened = new WorkspaceStore(directory);
    await reopened.load(createInitialWorkspace);
    await reopened.save({ ...loaded.workspace, camera: { panX: 7, panY: 9, zoom: 1 } });
    expect(await readFile(recoveryPath, 'utf8')).toBe('existing recovery copy');
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

  it('never overwrites unreadable primary and backup files when it has to start a new workspace', async () => {
    const directory = await temporaryDirectory();
    const store = new WorkspaceStore(directory);
    await writeFile(store.workspacePath, '{"truncated": ', 'utf8');
    await writeFile(store.backupPath, '[1, 2', 'utf8');

    const loaded = await store.load(createInitialWorkspace);
    expect(loaded.recoveredFrom).toBe('new');
    expect(loaded.warning).toMatch(/workspace\.corrupt-/);
    await store.save(loaded.workspace);
    await store.save({ ...loaded.workspace, camera: { panX: 1, panY: 1, zoom: 1 } });
    await store.save({ ...loaded.workspace, camera: { panX: 2, panY: 2, zoom: 1 } });

    const contents = Object.values(await filesIn(directory));
    expect(contents).toContain('{"truncated": ');
    expect(contents).toContain('[1, 2');
  });

  it('preserves a workspace written by a newer schema version instead of discarding it on downgrade', async () => {
    const directory = await temporaryDirectory();
    const store = new WorkspaceStore(directory);
    const future = JSON.stringify({ ...createInitialWorkspace(), schemaVersion: 3, futureField: 'user data from a newer release' });
    await writeFile(store.workspacePath, future, 'utf8');
    await writeFile(store.backupPath, future, 'utf8');

    const loaded = await store.load(createInitialWorkspace);
    expect(loaded.recoveredFrom).toBe('new');
    expect(loaded.warning).toMatch(/versión más reciente de OmniBrowser \(esquema 3\)/);
    await store.save(loaded.workspace);
    await store.save({ ...loaded.workspace, camera: { panX: 3, panY: 3, zoom: 1 } });

    const files = await filesIn(directory);
    const preserved = Object.entries(files).filter(([name]) => name.includes('.future-v3-'));
    expect(preserved).toHaveLength(2);
    expect(preserved.every(([, content]) => content === future)).toBe(true);
  });

  it('keeps the previous valid snapshot as backup even if the primary on disk was tampered with', async () => {
    const directory = await temporaryDirectory();
    const store = new WorkspaceStore(directory);
    const first = createInitialWorkspace();
    await store.save(first);
    await writeFile(store.workspacePath, '{"tampered": true}', 'utf8');
    await store.save({ ...first, camera: { panX: 9, panY: 9, zoom: 1 } });
    expect(JSON.parse(await readFile(store.backupPath, 'utf8'))).toEqual(first);
  });

  it('skips writes whose serialized content did not change', async () => {
    const directory = await temporaryDirectory();
    const store = new WorkspaceStore(directory);
    const workspace = createInitialWorkspace();
    expect(await store.save(workspace)).toBe('written');
    const firstWrite = (await lstat(store.workspacePath)).mtimeMs;
    expect(await store.save(structuredClone(workspace))).toBe('unchanged');
    expect((await lstat(store.workspacePath)).mtimeMs).toBe(firstWrite);
  });

  it('creates primary and backup files readable only by the user', async () => {
    const directory = await temporaryDirectory();
    const store = new WorkspaceStore(directory);
    const workspace = createInitialWorkspace();
    await store.save(workspace);
    await store.save({ ...workspace, camera: { panX: 4, panY: 4, zoom: 1 } });
    expect((await lstat(store.workspacePath)).mode & 0o777).toBe(0o600);
    expect((await lstat(store.backupPath)).mode & 0o777).toBe(0o600);
  });

  it('does not follow a symlinked workspace and preserves the link instead of reading its target', async () => {
    const directory = await temporaryDirectory();
    const store = new WorkspaceStore(directory);
    const outside = path.join(directory, 'outside.json');
    const outsideContent = JSON.stringify(createInitialWorkspace());
    await writeFile(outside, outsideContent, 'utf8');
    await symlink(outside, store.workspacePath);

    const loaded = await store.load(createInitialWorkspace);
    expect(loaded.recoveredFrom).toBe('new');
    expect(loaded.warning).toMatch(/no es un archivo regular/);
    await store.save(loaded.workspace);
    expect((await lstat(store.workspacePath)).isSymbolicLink()).toBe(false);
    expect(await readFile(outside, 'utf8')).toBe(outsideContent);
  });

  it('removes temporary files left by an interrupted write of another process', async () => {
    const directory = await temporaryDirectory();
    const stale = path.join(directory, '.workspace-999999-7c9e6679-7425-40de-944b-e07fc1f90ae7.tmp');
    const unrelated = path.join(directory, 'notes.tmp');
    await writeFile(stale, 'partial', 'utf8');
    await writeFile(unrelated, 'user file', 'utf8');
    await new WorkspaceStore(directory).load(createInitialWorkspace);
    const files = await readdir(directory);
    expect(files).not.toContain(path.basename(stale));
    expect(files).toContain('notes.tmp');
  });

  it('trims old history so a saved workspace always fits the size accepted on load', async () => {
    const huge = withHistory(createInitialWorkspace(), 500, 4000);
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(MAX_WORKSPACE_BYTES / 10);
    const serialized = serializeWorkspace(huge, MAX_WORKSPACE_BYTES / 10);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(MAX_WORKSPACE_BYTES / 10);
    const history = (JSON.parse(serialized) as WorkspaceFile).browsers[0]!.history;
    expect(history.entries[history.index]?.url).toBe(huge.browsers[0]!.history.entries.at(-1)?.url);
  });
});

describe('workspace migrations', () => {
  it('accepts the current schema unchanged', () => {
    const workspace = createInitialWorkspace();
    expect(migrateWorkspace(workspace)).toEqual(workspace);
  });

  it('upgrades V1 defaults and removes legacy temporary data and selection', () => {
    const persistent = createInitialWorkspace();
    const legacy = asLegacyV1(persistent);
    const timestamp = new Date().toISOString();
    const temporaryProfileId = '1c2b7a4e-5d6f-4a8b-9c0d-1e2f3a4b5c6d';
    const temporaryBrowserId = '2d3c8b5f-6e7a-4b9c-8d0e-2f3a4b5c6d7e';
    legacy.profiles = [
      ...(legacy.profiles as Array<Record<string, unknown>>),
      { id: temporaryProfileId, name: 'Temporal', kind: 'temporary', createdAt: timestamp, updatedAt: timestamp }
    ];
    legacy.browsers = [
      ...(legacy.browsers as Array<Record<string, unknown>>),
      {
        id: temporaryBrowserId,
        profileId: temporaryProfileId,
        worldRect: { x: 10, y: 10, width: 640, height: 440 },
        zIndex: 2,
        url: 'https://private.example/secret',
        title: 'Secret',
        history: { entries: [{ url: 'https://private.example/secret', title: 'Secret' }], index: 0 },
        suspended: false,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ];
    legacy.selectedBrowserId = temporaryBrowserId;

    const migrated = migrateWorkspace(legacy) as WorkspaceFile;
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      zones: [],
      stacks: [],
      preferences: { snapEnabled: false, historySwipeEnabled: false },
      selectedBrowserId: null
    });
    expect(migrated.profiles).toHaveLength(1);
    expect(migrated.browsers).toHaveLength(1);
    expect(migrated.browserOrder).toEqual([persistent.browsers[0]!.id]);
    expect(migrated.browsers[0]).toMatchObject({
      zoneId: null,
      presentation: 'normal',
      positionLocked: false,
      pin: { sidebar: false, viewport: null }
    });
    expect(JSON.stringify(migrated)).not.toContain('private.example');
  });

  it('rejects future and unknown versions explicitly', () => {
    expect(() => migrateWorkspace({ schemaVersion: 7 })).toThrow(WorkspaceVersionError);
    try {
      migrateWorkspace({ schemaVersion: 7 });
    } catch (error) {
      expect((error as WorkspaceVersionError).futureVersion).toBe(7);
    }
    expect(() => migrateWorkspace({ schemaVersion: '1' })).toThrow(/versión de esquema/);
    expect(() => migrateWorkspace({})).toThrow(/versión de esquema/);
  });

  it('applies registered upgrades in order and stamps each resulting version', () => {
    const migrated = migrateWorkspace({ schemaVersion: 1, steps: [] }, {
      1: (workspace) => ({ ...workspace, steps: [...(workspace.steps as string[]), 'v1→v2'] }),
      2: (workspace) => ({ ...workspace, steps: [...(workspace.steps as string[]), 'v2→v3'] })
    }, 3);
    expect(migrated).toEqual({ schemaVersion: 3, steps: ['v1→v2', 'v2→v3'] });
    expect(() => migrateWorkspace({ schemaVersion: 1 }, {}, 2)).toThrow(/No existe una migración/);
  });
});
