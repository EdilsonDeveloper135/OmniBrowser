import { describe, expect, it } from 'vitest';
import { BrowserNotFoundError, createInitialWorkspace, WorkspaceModel } from '../../src/main/domain/workspace-model';
import { MAX_URL_LENGTH } from '../../src/shared/constants';
import { OmniUserError } from '../../src/shared/errors';
import { setPreferencesInputSchema, workspaceFileSchema } from '../../src/shared/schemas';
import { raiseToTop } from '../../src/shared/z-order';

describe('WorkspaceModel persistence projection', () => {
  it('creates the required Personal profile and a non-persisted Private profile', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    expect(model.listProfiles().map((profile) => [profile.name, profile.kind])).toEqual([
      ['Personal', 'persistent'],
      ['Private', 'private']
    ]);
    expect(model.toPersistentFile().profiles.map((profile) => profile.name)).toEqual(['Personal']);
  });

  it('removes private profiles and every associated browser, URL, and history entry from disk state', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const privateProfile = model.listProfiles().find((profile) => profile.kind === 'private');
    expect(privateProfile).toBeDefined();
    const browser = model.createBrowser(privateProfile!.id, { url: 'https://private.example/path', title: 'Private page' });
    model.setNavigation(browser.id, {
      url: 'https://private.example/path',
      title: 'Private page',
      history: { entries: [{ url: 'https://private.example/path', title: 'Private page' }], index: 0 }
    });
    const second = model.createBrowser(privateProfile!.id, { url: 'https://private.example/second' });
    const privateZone = model.createZone(privateProfile!.id, 'Secret zone', '#123456', [browser.id, second.id]);
    const privateStack = model.createStack(privateZone.id, [browser.id, second.id]);
    model.setSidebarPinned([browser.id], true);

    const persistent = model.toPersistentFile();
    const serialized = JSON.stringify(persistent);
    expect(serialized).not.toContain(privateProfile!.id);
    expect(serialized).not.toContain(browser.id);
    expect(serialized).not.toContain(privateZone.id);
    expect(serialized).not.toContain(privateStack.id);
    expect(serialized).not.toContain('private.example');
    expect(persistent.browserOrder).not.toContain(browser.id);
    expect(persistent.browserOrder).not.toContain(second.id);
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
  it('rejects orphaned zones, incomplete sidebar order and cross-zone stacks at the schema boundary', () => {
    const workspace = createInitialWorkspace();
    const browser = workspace.browsers[0]!;
    const orphaned = structuredClone(workspace);
    orphaned.browsers[0]!.zoneId = '1c2b7a4e-5d6f-4a8b-9c0d-1e2f3a4b5c6d';
    expect(workspaceFileSchema.safeParse(orphaned).success).toBe(false);

    const incompleteOrder = structuredClone(workspace);
    incompleteOrder.browserOrder = [];
    expect(workspaceFileSchema.safeParse(incompleteOrder).success).toBe(false);

    const timestamp = new Date().toISOString();
    const zoneId = '2d3c8b5f-6e7a-4b9c-8d0e-2f3a4b5c6d7e';
    const otherZoneId = '3e4d9c6a-7f8b-4c0d-9e1f-3a4b5c6d7e8f';
    const secondId = '4f5e0d7b-8a9c-4d1e-8f2a-4b5c6d7e8f90';
    const crossZone = structuredClone(workspace);
    crossZone.zones = [
      { id: zoneId, profileId: browser.profileId, name: 'A', color: '#112233', collapsed: false, createdAt: timestamp, updatedAt: timestamp },
      { id: otherZoneId, profileId: browser.profileId, name: 'B', color: '#445566', collapsed: false, createdAt: timestamp, updatedAt: timestamp }
    ];
    crossZone.browsers[0]!.zoneId = zoneId;
    crossZone.browsers.push({ ...structuredClone(browser), id: secondId, zoneId: otherZoneId, zIndex: 2 });
    crossZone.browserOrder.push(secondId);
    crossZone.stacks = [{ id: '5a6f1e8c-9b0d-4e2f-8a3b-5c6d7e8f901a', zoneId, browserIds: [browser.id, secondId], createdAt: timestamp, updatedAt: timestamp }];
    expect(workspaceFileSchema.safeParse(crossZone).success).toBe(false);
  });

  it('prevalidates bulk mutations so a stale id cannot leave partial state', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const first = model.listBrowsers()[0]!;
    const missing = '6b7a2f9d-0c1e-4f3a-9b4c-6d7e8f901a2b';
    expect(() => model.setPositionLocked([first.id, missing], true)).toThrow(BrowserNotFoundError);
    expect(model.getBrowser(first.id).positionLocked).toBe(false);
    expect(() => model.duplicateBrowsers([first.id, missing])).toThrow(BrowserNotFoundError);
    expect(model.listBrowsers()).toHaveLength(1);
  });

  it('never creates more browsers than a snapshot and native layout batch can represent', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const profile = model.listProfiles()[0]!;
    for (let index = 1; index < 500; index += 1) model.createBrowser(profile.id, { suspended: true });
    expect(model.listBrowsers()).toHaveLength(500);
    expect(() => model.createBrowser(profile.id)).toThrow(/límite de 500/);
    expect(() => model.duplicateBrowsers([model.listBrowsers()[0]!.id])).toThrow(/límite de 500/);
  });

  it('keeps canonical geometry through minimize and rejects locked or viewport-pinned layout commits', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const browser = model.listBrowsers()[0]!;
    const movedAndResized = {
      x: browser.worldRect.x + 18,
      y: browser.worldRect.y + 22,
      width: browser.worldRect.width + 140,
      height: browser.worldRect.height + 90
    };
    const item = (worldRect: typeof browser.worldRect) => ({
      browserId: browser.id,
      worldRect,
      screenBounds: { x: 320, y: 140, width: 500, height: 360 },
      visible: true
    });

    model.setPresentation([browser.id], 'minimized');
    expect(model.commitLayout({ items: [item(movedAndResized)] })).toBe(true);
    expect(model.getBrowser(browser.id).worldRect).toEqual({
      x: movedAndResized.x,
      y: movedAndResized.y,
      width: browser.worldRect.width,
      height: browser.worldRect.height
    });

    model.setPresentation([browser.id], 'normal');
    model.setPositionLocked([browser.id], true);
    expect(model.commitLayout({ items: [item({ ...movedAndResized, x: movedAndResized.x + 100 })] })).toBe(false);
    model.setPositionLocked([browser.id], false);
    model.setViewportPin(browser.id, { x: 0.1, y: 0.1, width: 0.4, height: 0.4 });
    expect(model.commitLayout({ items: [item({ ...movedAndResized, y: movedAndResized.y + 100 })] })).toBe(false);
    expect(model.getBrowser(browser.id).worldRect.x).toBe(movedAndResized.x);
    model.setViewportPin(browser.id, null);
    expect(model.getBrowser(browser.id).worldRect.x).toBe(movedAndResized.x);
  });

  it('duplicates session history and zone while resetting visual flags and stack membership', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const profile = model.listProfiles()[0]!;
    const source = model.listBrowsers()[0]!;
    const sibling = model.createBrowser(profile.id);
    model.setNavigation(source.id, {
      url: 'https://example.com/current',
      title: 'Current',
      history: {
        entries: [
          { url: 'https://example.com/start', title: 'Start' },
          { url: 'https://example.com/current', title: 'Current' }
        ],
        index: 1
      }
    });
    const zone = model.createZone(profile.id, 'Research', '#4477aa', [source.id, sibling.id]);
    const stack = model.createStack(zone.id, [sibling.id, source.id]);
    model.setPositionLocked([source.id], true);
    model.setSidebarPinned([source.id], true);

    const [copy] = model.duplicateBrowsers([source.id]);
    expect(copy).toMatchObject({
      profileId: source.profileId,
      zoneId: zone.id,
      url: 'https://example.com/current',
      title: 'Current',
      presentation: 'normal',
      positionLocked: false,
      pin: { sidebar: false, viewport: null }
    });
    expect(copy!.history).toEqual(model.getBrowser(source.id).history);
    expect(copy!.worldRect).toEqual({
      ...model.getBrowser(source.id).worldRect,
      x: model.getBrowser(source.id).worldRect.x + 32,
      y: model.getBrowser(source.id).worldRect.y + 24
    });
    expect(model.listStacks().find((candidate) => candidate.id === stack.id)?.browserIds).not.toContain(copy!.id);
  });

  it('maintains zone and stack integrity while selecting, removing and ungrouping members', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const profile = model.listProfiles()[0]!;
    const first = model.listBrowsers()[0]!;
    const second = model.createBrowser(profile.id);
    const third = model.createBrowser(profile.id);
    expect(() => model.createZone(profile.id, 'Empty', '#112233', [])).toThrow(/al menos un navegador/);
    const zone = model.createZone(profile.id, 'Work', '#112233', [first.id, second.id, third.id]);
    const stack = model.createStack(zone.id, [first.id, second.id]);
    model.selectStackMember(stack.id, first.id);
    expect(model.listStacks()[0]?.browserIds.at(-1)).toBe(first.id);
    model.addStackMember(stack.id, third.id);
    expect(model.listStacks()[0]?.browserIds.at(-1)).toBe(third.id);
    expect(model.getBrowser(third.id).worldRect).toEqual(model.getBrowser(first.id).worldRect);

    model.removeBrowser(third.id);
    expect(model.listStacks()[0]?.browserIds).toEqual([second.id, first.id]);
    model.unstack(stack.id);
    expect(model.listStacks()).toHaveLength(0);
    expect(new Set([model.getBrowser(first.id).worldRect.x, model.getBrowser(second.id).worldRect.x]).size).toBe(2);
    model.assignZone([first.id, second.id], null);
    expect(model.listZones()).toHaveLength(0);
  });

  it('moves across privacy boundaries with only the current URL and no session history', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const browser = model.listBrowsers()[0]!;
    const privateProfile = model.listProfiles().find((profile) => profile.kind === 'private')!;
    model.setNavigation(browser.id, {
      url: 'https://example.com/current',
      title: 'Current',
      history: {
        entries: [
          { url: 'https://example.com/one', title: 'One' },
          { url: 'https://example.com/two', title: 'Two' },
          { url: 'https://example.com/current', title: 'Current' }
        ],
        index: 2
      }
    });
    model.assignProfile(browser.id, privateProfile.id);
    expect(model.getBrowser(browser.id).history).toEqual({
      entries: [{ url: 'https://example.com/current', title: 'Current' }],
      index: 0
    });
    expect(JSON.stringify(model.toPersistentFile())).not.toContain('example.com/current');
  });

  it('validates sidebar order independently of z-order and persists workspace preferences', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const profile = model.listProfiles()[0]!;
    const first = model.listBrowsers()[0]!;
    const second = model.createBrowser(profile.id);
    const beforeZ = model.listBrowsers().map(({ id, zIndex }) => [id, zIndex]);
    model.setBrowserOrder([second.id, first.id]);
    model.setPreferences({ snapEnabled: true });
    const snapshot = model.toSnapshot(new Map(), 'saved');
    expect(snapshot.browserOrder).toEqual([second.id, first.id]);
    expect(snapshot.preferences).toEqual({ snapEnabled: true, historySwipeEnabled: false });
    expect(model.listBrowsers().map(({ id, zIndex }) => [id, zIndex])).toEqual(beforeZ);
    expect(() => model.setBrowserOrder([first.id, first.id])).toThrow(/exactamente una vez/);
  });

  it('keeps history swipe disabled while the trackpad gesture gate is closed', () => {
    const file = createInitialWorkspace();
    const model = new WorkspaceModel({ ...file, preferences: { snapEnabled: true, historySwipeEnabled: true } });
    expect(model.toSnapshot(new Map(), 'saved').preferences).toEqual({ snapEnabled: true, historySwipeEnabled: false });
    model.setPreferences({ historySwipeEnabled: true });
    expect(model.toPersistentFile().preferences).toEqual({ snapEnabled: true, historySwipeEnabled: false });
    expect(setPreferencesInputSchema.safeParse({ historySwipeEnabled: true }).success).toBe(false);
    expect(setPreferencesInputSchema.safeParse({ historySwipeEnabled: false }).success).toBe(true);
    expect(setPreferencesInputSchema.safeParse({ snapEnabled: false }).success).toBe(true);
  });

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

  it('picks a unique private profile name when a persistent profile already uses it', () => {
    const workspace = createInitialWorkspace();
    const timestamp = new Date().toISOString();
    workspace.profiles.push({ id: '1c2b7a4e-5d6f-4a8b-9c0d-1e2f3a4b5c6d', name: 'Private', kind: 'persistent', createdAt: timestamp, updatedAt: timestamp });
    const model = new WorkspaceModel(workspace);
    expect(model.listProfiles().filter((profile) => profile.kind === 'private').map((profile) => profile.name)).toEqual(['Private 2']);
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
