import { describe, expect, it } from 'vitest';
import { createInitialWorkspace, WorkspaceModel } from '../../src/main/domain/workspace-model';

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
        zIndex: originalBrowser.zIndex,
        screenBounds: { x: 300, y: 120, width: 500, height: 360 },
        visible: true
      }]
    });

    expect(model.selectedBrowserId).toBe(newerBrowser.id);
  });
});
