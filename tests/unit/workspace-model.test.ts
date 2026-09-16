import { describe, expect, it } from 'vitest';
import { BrowserNotFoundError, createInitialWorkspace, WorkspaceModel } from '../../src/main/domain/workspace-model';
import { MAX_URL_LENGTH } from '../../src/shared/constants';
import { OmniUserError } from '../../src/shared/errors';
import { workspaceFileSchema } from '../../src/shared/schemas';
import { raiseToTop } from '../../src/shared/z-order';

describe('WorkspaceModel persistence projection', () => {
  it('creates the required Personal profile and a non-persisted Temporal profile', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    expect(model.listProfiles().map((profile) => [profile.name, profile.kind])).toEqual([
      ['Personal', 'persistent'],
      ['Temporal', 'temporary']
    ]);
    expect(model.toPersistentFile().profiles.map((profile) => profile.name)).toEqual(['Personal']);
  });

  it('removes temporary profiles and every associated browser, URL, and history entry from disk state', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const temporary = model.listProfiles().find((profile) => profile.kind === 'temporary');
    expect(temporary).toBeDefined();
    const browser = model.createBrowser(temporary!.id, { url: 'https://private.example/path', title: 'Private temporary page' });
    model.setNavigation(browser.id, {
      url: 'https://private.example/path',
      title: 'Private temporary page',
      history: { entries: [{ url: 'https://private.example/path', title: 'Private temporary page' }], index: 0 }
    });

    const serialized = JSON.stringify(model.toPersistentFile());
    expect(serialized).not.toContain(temporary!.id);
    expect(serialized).not.toContain(browser.id);
    expect(serialized).not.toContain('private.example');
  });

  it('keeps persistent profiles and their browsers isolated by profile id', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const work = model.createProfile('Trabajo', 'persistent');
    const browser = model.createBrowser(work.id);
    const file = model.toPersistentFile();
    expect(file.profiles.some((profile) => profile.id === work.id)).toBe(true);
    expect(file.browsers.find((candidate) => candidate.id === browser.id)?.profileId).toBe(work.id);
  });

  it('rejects duplicate profile names without case sensitivity', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    expect(() => model.createProfile('personal', 'persistent')).toThrow(/Ya existe/);
  });

  it('does not let a geometry commit overwrite a newer browser selection', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const personal = model.listProfiles().find((profile) => profile.name === 'Personal')!;
    const originalBrowser = model.listBrowsers()[0]!;
    const newerBrowser = model.createBrowser(personal.id);

    model.commitLayout({
      items: [{
        browserId: originalBrowser.id,
        worldRect: originalBrowser.worldRect,
        screenBounds: { x: 300, y: 120, width: 500, height: 360 },
        visible: true
      }]
    });

    expect(model.selectedBrowserId).toBe(newerBrowser.id);
  });
});

describe('WorkspaceModel integrity', () => {
  it('keeps the workspace serializable after Chromium reports URLs longer than the persisted limit', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const browser = model.listBrowsers()[0]!;
    const shortUrl = 'https://example.com/start';
    const longUrl = `https://example.com/?${'q'.repeat(MAX_URL_LENGTH)}`;
    model.setNavigation(browser.id, {
      url: longUrl,
      title: 'Long',
      history: { entries: [{ url: shortUrl, title: 'Start' }, { url: longUrl, title: 'Long' }], index: 1 }
    });
    const file = model.toPersistentFile();
    expect(workspaceFileSchema.safeParse(file).success).toBe(true);
    expect(file.browsers[0]).toMatchObject({ url: shortUrl, history: { entries: [{ url: shortUrl, title: 'Start' }], index: 0 } });
  });

  it('distinguishes location, title-only and no-op navigation updates', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const { id } = model.listBrowsers()[0]!;
    const history = { entries: [{ url: 'https://a.example/', title: 'A' }], index: 0 };
    expect(model.setNavigation(id, { url: 'https://a.example/', title: 'A', history })).toBe('location');
    expect(model.setNavigation(id, { url: 'https://a.example/', title: 'A', history })).toBe('none');
    expect(model.setNavigation(id, { url: 'https://a.example/', title: 'A (3)', history })).toBe('title');
    expect(model.setNavigation(id, { url: 'https://a.example/', title: '', history })).toBe('none');
    expect(model.getBrowser(id).title).toBe('A (3)');
  });

  it('keeps z-order dense after any number of focus operations', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const personal = model.listProfiles()[0]!;
    const ids = [model.listBrowsers()[0]!.id, model.createBrowser(personal.id).id, model.createBrowser(personal.id).id];
    for (let index = 0; index < 5000; index += 1) model.focusBrowser(ids[index % ids.length]!);
    expect(model.listBrowsers().map((browser) => browser.zIndex)).toEqual([1, 2, 3]);
    expect(workspaceFileSchema.safeParse(model.toPersistentFile()).success).toBe(true);
    expect(model.focusBrowser(model.listBrowsers().at(-1)!.id)).toBe(false);
  });

  it('computes the same z-order as the shell optimistic update', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const personal = model.listProfiles()[0]!;
    model.createBrowser(personal.id);
    model.createBrowser(personal.id);
    const before = model.toSnapshot(new Map(), 'saved').browsers;
    const target = before[0]!.id;
    const optimistic = raiseToTop(before, target).map(({ id, zIndex }) => ({ id, zIndex }));
    model.focusBrowser(target);
    expect(model.toSnapshot(new Map(), 'saved').browsers.map(({ id, zIndex }) => ({ id, zIndex })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual(optimistic.sort((a, b) => a.id.localeCompare(b.id)));
  });

  it('does not mark the workspace as changed for layout, camera or bounds updates that change nothing', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const browser = model.listBrowsers()[0]!;
    const before = JSON.stringify(model.toPersistentFile());
    expect(model.commitLayout({ items: [{ browserId: browser.id, worldRect: browser.worldRect, screenBounds: { x: 300, y: 120, width: 500, height: 360 }, visible: true }] })).toBe(false);
    expect(model.setCamera(model.toSnapshot(new Map(), 'saved').camera)).toBe(false);
    expect(JSON.stringify(model.toPersistentFile())).toBe(before);
    expect(model.commitLayout({ items: [{ browserId: browser.id, worldRect: { ...browser.worldRect, x: browser.worldRect.x + 1 }, screenBounds: { x: 300, y: 120, width: 500, height: 360 }, visible: true }] })).toBe(true);
  });

  it('never exposes navigation history in shell snapshots', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const { id } = model.listBrowsers()[0]!;
    model.setNavigation(id, { url: 'https://a.example/', title: 'A', history: { entries: [{ url: 'https://secret-history.example/', title: 'S' }, { url: 'https://a.example/', title: 'A' }], index: 1 } });
    const snapshot = model.toSnapshot(new Map(), 'saved');
    expect(JSON.stringify(snapshot)).not.toContain('secret-history.example');
    expect(snapshot.browsers[0]?.runtime.canGoBack).toBe(true);
  });

  it('picks a unique temporary profile name when a persistent profile already uses it', () => {
    const workspace = createInitialWorkspace();
    const timestamp = new Date().toISOString();
    workspace.profiles.push({ id: '1c2b7a4e-5d6f-4a8b-9c0d-1e2f3a4b5c6d', name: 'Temporal', kind: 'persistent', createdAt: timestamp, updatedAt: timestamp });
    const model = new WorkspaceModel(workspace);
    expect(model.listProfiles().filter((profile) => profile.kind === 'temporary').map((profile) => profile.name)).toEqual(['Temporal 2']);
  });

  it('reports missing browsers and profiles as localized user errors', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    expect(() => model.getBrowser('00000000-0000-4000-8000-000000000000')).toThrow(BrowserNotFoundError);
    expect(() => model.focusBrowser('00000000-0000-4000-8000-000000000000')).toThrow('El navegador ya no existe.');
    try {
      model.createBrowser('00000000-0000-4000-8000-000000000000');
    } catch (error) {
      expect(error).toBeInstanceOf(OmniUserError);
      expect((error as OmniUserError).message).toBe('El perfil ya no existe.');
    }
  });
});
