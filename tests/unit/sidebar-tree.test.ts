import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInitialWorkspace, WorkspaceModel } from '../../src/main/domain/workspace-model';
import {
  browserMatchesSidebarSearch,
  buildSidebarTreeIndex,
  normalizeSidebarSearch
} from '../../src/renderer/lib/sidebar-tree';
import type { BrowserSnapshot, WorkspaceSnapshot } from '../../src/shared/schemas';

describe('sidebar tree derivation', () => {
  it('normalizes accents and searches title, domain and full URL locally', () => {
    const snapshot = new WorkspaceModel(createInitialWorkspace()).toSnapshot(new Map(), 'saved');
    const browser = {
      ...snapshot.browsers[0]!,
      title: 'Investigación Pública',
      url: 'https://docs.example.com/path?q=canvas'
    };
    expect(normalizeSidebarSearch('  INVESTIGACIÓN   pública ')).toBe('investigacion publica');
    expect(browserMatchesSidebarSearch(browser, normalizeSidebarSearch('investigacion'))).toBe(true);
    expect(browserMatchesSidebarSearch(browser, normalizeSidebarSearch('docs.example.com'))).toBe(true);
    expect(browserMatchesSidebarSearch(browser, normalizeSidebarSearch('q=canvas'))).toBe(true);
    expect(browserMatchesSidebarSearch(browser, normalizeSidebarSearch('missing'))).toBe(false);
  });

  it('indexes profile, zone, stack and sidebar order relationships once', () => {
    const model = new WorkspaceModel(createInitialWorkspace());
    const profile = model.listProfiles()[0]!;
    const first = model.listBrowsers()[0]!;
    const second = model.createBrowser(profile.id);
    const loose = model.createBrowser(profile.id);
    const zone = model.createZone(profile.id, 'Research', '#336699', [first.id, second.id]);
    const stack = model.createStack(zone.id, [first.id, second.id]);
    model.setBrowserOrder([loose.id, second.id, first.id]);

    const tree = buildSidebarTreeIndex(model.toSnapshot(new Map(), 'saved'));
    expect(tree.orderedBrowsers.map((browser) => browser.id)).toEqual([loose.id, second.id, first.id]);
    expect(tree.browsersByProfile.get(profile.id)).toHaveLength(3);
    expect(tree.looseBrowsersByProfile.get(profile.id)?.map((browser) => browser.id)).toEqual([loose.id]);
    expect(tree.browsersByZone.get(zone.id)).toHaveLength(2);
    expect(tree.zonesByProfile.get(profile.id)?.map((candidate) => candidate.id)).toEqual([zone.id]);
    expect(tree.stacksByZone.get(zone.id)?.map((candidate) => candidate.id)).toEqual([stack.id]);
    expect(tree.stackMembersById.get(stack.id)?.map((browser) => browser.id)).toEqual([first.id, second.id]);
    expect(tree.stackedBrowserIdsByZone.get(zone.id)).toEqual(new Set([first.id, second.id]));
  });

  it('derives and searches the supported 500-browser workspace without dropping identities', () => {
    const base = new WorkspaceModel(createInitialWorkspace()).toSnapshot(new Map(), 'saved');
    const profile = base.profiles[0]!;
    const template = base.browsers[0]!;
    const browsers: BrowserSnapshot[] = Array.from({ length: 500 }, (_, index) => ({
      ...structuredClone(template),
      id: randomUUID(),
      title: index === 499 ? 'Needle Browser' : `Browser ${index}`,
      url: index === 499 ? 'https://needle.example/final' : `https://example.com/${index}`,
      zIndex: index + 1
    }));
    const snapshot: WorkspaceSnapshot = {
      ...base,
      profiles: [profile],
      browsers,
      browserOrder: browsers.map((browser) => browser.id),
      selectedBrowserId: browsers[0]!.id
    };

    const tree = buildSidebarTreeIndex(snapshot);
    expect(tree.orderedBrowsers).toHaveLength(500);
    expect(tree.browserById.size).toBe(500);
    expect(tree.browsersByProfile.get(profile.id)).toHaveLength(500);
    const query = normalizeSidebarSearch('needle.example');
    expect(tree.orderedBrowsers.filter((browser) => browserMatchesSidebarSearch(browser, query)).map((browser) => browser.title)).toEqual(['Needle Browser']);
  });
});
