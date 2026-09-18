import type { BrowserSnapshot, StackRecord, WorkspaceSnapshot, ZoneRecord } from '../../shared/schemas';
import { displayDomain } from '../../shared/urls';

export interface SidebarTreeIndex {
  browserById: Map<string, BrowserSnapshot>;
  orderedBrowsers: BrowserSnapshot[];
  browsersByProfile: Map<string, BrowserSnapshot[]>;
  looseBrowsersByProfile: Map<string, BrowserSnapshot[]>;
  browsersByZone: Map<string, BrowserSnapshot[]>;
  zonesByProfile: Map<string, ZoneRecord[]>;
  stacksByZone: Map<string, StackRecord[]>;
  stackMembersById: Map<string, BrowserSnapshot[]>;
  stackedBrowserIdsByZone: Map<string, Set<string>>;
}

function appendToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const entries = map.get(key);
  if (entries) entries.push(value); else map.set(key, [value]);
}

export function normalizeSidebarSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function browserMatchesSidebarSearch(browser: BrowserSnapshot, normalizedQuery: string): boolean {
  return !normalizedQuery || normalizeSidebarSearch(`${browser.title} ${displayDomain(browser.url)} ${browser.url}`).includes(normalizedQuery);
}

export function buildSidebarTreeIndex(snapshot: Pick<WorkspaceSnapshot, 'browsers' | 'browserOrder' | 'zones' | 'stacks'>): SidebarTreeIndex {
  const browserById = new Map(snapshot.browsers.map((browser) => [browser.id, browser]));
  const orderedBrowsers = snapshot.browserOrder
    .map((id) => browserById.get(id))
    .filter((browser): browser is BrowserSnapshot => Boolean(browser));
  const browsersByProfile = new Map<string, BrowserSnapshot[]>();
  const looseBrowsersByProfile = new Map<string, BrowserSnapshot[]>();
  const browsersByZone = new Map<string, BrowserSnapshot[]>();
  for (const browser of orderedBrowsers) {
    appendToMap(browsersByProfile, browser.profileId, browser);
    if (browser.zoneId) appendToMap(browsersByZone, browser.zoneId, browser);
    else appendToMap(looseBrowsersByProfile, browser.profileId, browser);
  }
  const zonesByProfile = new Map<string, ZoneRecord[]>();
  for (const zone of snapshot.zones) appendToMap(zonesByProfile, zone.profileId, zone);
  const stacksByZone = new Map<string, StackRecord[]>();
  const stackMembersById = new Map<string, BrowserSnapshot[]>();
  const stackedBrowserIdsByZone = new Map<string, Set<string>>();
  for (const stack of snapshot.stacks) {
    appendToMap(stacksByZone, stack.zoneId, stack);
    stackMembersById.set(stack.id, stack.browserIds.map((id) => browserById.get(id)).filter((browser): browser is BrowserSnapshot => Boolean(browser)));
    const stacked = stackedBrowserIdsByZone.get(stack.zoneId) ?? new Set<string>();
    for (const browserId of stack.browserIds) stacked.add(browserId);
    stackedBrowserIdsByZone.set(stack.zoneId, stacked);
  }
  return {
    browserById,
    orderedBrowsers,
    browsersByProfile,
    looseBrowsersByProfile,
    browsersByZone,
    zonesByProfile,
    stacksByZone,
    stackMembersById,
    stackedBrowserIdsByZone
  };
}
