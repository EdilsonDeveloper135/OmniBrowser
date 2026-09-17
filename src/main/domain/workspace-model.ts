import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BROWSER_URL,
  MAX_BROWSER_COUNT_PER_LAYOUT_BATCH,
  MAX_TITLE_LENGTH,
  WORKSPACE_SCHEMA_VERSION
} from '../../shared/constants';
import { OmniUserError } from '../../shared/errors';
import { clampWorldRect } from '../../shared/geometry';
import {
  browserRecordSchema,
  cameraSchema,
  normalizedViewportRectSchema,
  profileNameSchema,
  profileSchema,
  stackRecordSchema,
  workspaceFileSchema,
  worldRectSchema,
  zoneColorSchema,
  zoneNameSchema,
  zoneRecordSchema,
  type BrowserRecord,
  type BrowserRuntimeState,
  type BrowserSnapshot,
  type Camera,
  type LayoutBatch,
  type NormalizedViewportRect,
  type ProfileRecord,
  type StackRecord,
  type WorkspaceFile,
  type WorkspacePreferences,
  type WorkspaceSnapshot,
  type WorldRect,
  type ZoneRecord
} from '../../shared/schemas';
import { isPersistableNavigationUrl } from '../../shared/urls';
import { sanitizeHistory, type RawHistoryEntry } from './navigation-history';

export type NavigationChange = 'none' | 'title' | 'location';

const DEFAULT_PREFERENCES: WorkspacePreferences = { snapEnabled: false, historySwipeEnabled: false };

const defaultRuntimeState = (record: BrowserRecord): BrowserRuntimeState => ({
  isAwake: !record.suspended,
  isLoading: false,
  canGoBack: record.history.index > 0,
  canGoForward: record.history.entries.length > 0 && record.history.index < record.history.entries.length - 1,
  crashed: false,
  isAudible: false,
  faviconKey: null,
  download: { activeCount: 0, receivedBytes: 0, totalBytes: null, status: 'idle' },
  lastError: null
});

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameRect(a: WorldRect, b: WorldRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sameCamera(a: Camera, b: Camera): boolean {
  return a.panX === b.panX && a.panY === b.panY && a.zoom === b.zoom;
}

export class BrowserNotFoundError extends OmniUserError {
  constructor() {
    super('not-found', 'El navegador ya no existe.');
  }
}

export class ProfileNotFoundError extends OmniUserError {
  constructor() {
    super('not-found', 'El perfil ya no existe.');
  }
}

export function createInitialWorkspace(): WorkspaceFile {
  const timestamp = now();
  const personalProfile: ProfileRecord = {
    id: randomUUID(),
    name: 'Personal',
    kind: 'persistent',
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const firstBrowser: BrowserRecord = {
    id: randomUUID(),
    profileId: personalProfile.id,
    zoneId: null,
    worldRect: { x: 72, y: 72, width: 640, height: 440 },
    zIndex: 1,
    url: DEFAULT_BROWSER_URL,
    title: 'Nueva página',
    history: { entries: [], index: 0 },
    suspended: false,
    presentation: 'normal',
    positionLocked: false,
    pin: { sidebar: false, viewport: null },
    createdAt: timestamp,
    updatedAt: timestamp
  };
  return workspaceFileSchema.parse({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    profiles: [personalProfile],
    browsers: [firstBrowser],
    zones: [],
    stacks: [],
    browserOrder: [firstBrowser.id],
    preferences: DEFAULT_PREFERENCES,
    camera: { panX: 0, panY: 0, zoom: 0.82 },
    selectedBrowserId: firstBrowser.id,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export class WorkspaceModel {
  readonly #profiles = new Map<string, ProfileRecord>();
  readonly #browsers = new Map<string, BrowserRecord>();
  readonly #zones = new Map<string, ZoneRecord>();
  readonly #stacks = new Map<string, StackRecord>();
  #browserOrder: string[];
  #preferences: WorkspacePreferences;
  #camera: Camera;
  #selectedBrowserId: string | null;
  #windowBounds: WorkspaceFile['windowBounds'];
  readonly #createdAt: string;
  #updatedAt: string;

  constructor(file: WorkspaceFile, privateProfileName = 'Private') {
    const parsed = workspaceFileSchema.parse(file);
    for (const profile of parsed.profiles) this.#profiles.set(profile.id, clone(profile));
    for (const browser of parsed.browsers) this.#browsers.set(browser.id, clone(browser));
    for (const zone of parsed.zones) this.#zones.set(zone.id, clone(zone));
    for (const stack of parsed.stacks) this.#stacks.set(stack.id, clone(stack));
    this.#browserOrder = [...parsed.browserOrder];
    this.#preferences = clone(parsed.preferences);
    this.#camera = clone(parsed.camera);
    this.#selectedBrowserId = parsed.selectedBrowserId;
    this.#windowBounds = parsed.windowBounds ? clone(parsed.windowBounds) : undefined;
    this.#createdAt = parsed.createdAt;
    this.#updatedAt = parsed.updatedAt;
    this.#normalizeZOrder();
    const persistentTimestamp = this.#updatedAt;
    this.createProfile(this.#uniqueProfileName(privateProfileName), 'private');
    this.#updatedAt = persistentTimestamp;
  }

  listProfiles(): ProfileRecord[] {
    return [...this.#profiles.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone);
  }

  listBrowsers(): BrowserRecord[] {
    return this.#orderedBrowsers().map(clone);
  }

  listZones(): ZoneRecord[] {
    return [...this.#zones.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone);
  }

  listStacks(): StackRecord[] {
    return [...this.#stacks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone);
  }

  get selectedBrowserId(): string | null {
    return this.#selectedBrowserId;
  }

  getProfile(profileId: string): ProfileRecord {
    return clone(this.#requireProfile(profileId));
  }

  getBrowser(browserId: string): BrowserRecord {
    return clone(this.#requireBrowser(browserId));
  }

  getZone(zoneId: string): ZoneRecord {
    return clone(this.#requireZone(zoneId));
  }

  hasBrowser(browserId: string): boolean {
    return this.#browsers.has(browserId);
  }

  isSuspended(browserId: string): boolean {
    return this.#requireBrowser(browserId).suspended;
  }

  zIndexOf(browserId: string): number {
    return this.#requireBrowser(browserId).zIndex;
  }

  createProfile(nameInput: string, kind: ProfileRecord['kind']): ProfileRecord {
    const name = profileNameSchema.parse(nameInput);
    if (this.#hasProfileNamed(name)) throw new OmniUserError('conflict', `Ya existe un perfil llamado “${name}”.`);
    const timestamp = now();
    const profile = profileSchema.parse({ id: randomUUID(), name, kind, createdAt: timestamp, updatedAt: timestamp });
    this.#profiles.set(profile.id, profile);
    this.#touch(timestamp);
    return clone(profile);
  }

  createBrowser(profileId: string, options: {
    url?: string;
    worldRect?: WorldRect;
    title?: string;
    suspended?: boolean;
    history?: BrowserRecord['history'];
    zoneId?: string | null;
  } = {}): BrowserRecord {
    const profile = this.#requireProfile(profileId);
    if (this.#browsers.size >= MAX_BROWSER_COUNT_PER_LAYOUT_BATCH) {
      throw new OmniUserError('conflict', `Se alcanzó el límite de ${MAX_BROWSER_COUNT_PER_LAYOUT_BATCH} navegadores.`);
    }
    if (options.zoneId && this.#requireZone(options.zoneId).profileId !== profile.id) {
      throw new OmniUserError('conflict', 'La zona pertenece a otro perfil.');
    }
    const timestamp = now();
    const existingCount = this.#browsers.size;
    const worldRect = worldRectSchema.parse(options.worldRect ?? {
      x: 72 + (existingCount % 8) * 42,
      y: 72 + (existingCount % 8) * 36,
      width: 640,
      height: 440
    });
    const browser = browserRecordSchema.parse({
      id: randomUUID(),
      profileId,
      zoneId: options.zoneId ?? null,
      worldRect,
      zIndex: existingCount + 1,
      url: options.url && isPersistableNavigationUrl(options.url) ? options.url : DEFAULT_BROWSER_URL,
      title: (options.title ?? 'Nueva página').slice(0, MAX_TITLE_LENGTH),
      history: options.history ?? { entries: [], index: 0 },
      suspended: options.suspended ?? false,
      presentation: 'normal',
      positionLocked: false,
      pin: { sidebar: false, viewport: null },
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.#browsers.set(browser.id, browser);
    this.#browserOrder.push(browser.id);
    this.#selectedBrowserId = browser.id;
    this.#normalizeZOrder();
    this.#touch(timestamp);
    return clone(browser);
  }

  duplicateBrowsers(browserIds: readonly string[]): BrowserRecord[] {
    const sources = this.#requireBrowsers(browserIds);
    if (this.#browsers.size + sources.length > MAX_BROWSER_COUNT_PER_LAYOUT_BATCH) {
      throw new OmniUserError('conflict', `Duplicar la selección superaría el límite de ${MAX_BROWSER_COUNT_PER_LAYOUT_BATCH} navegadores.`);
    }
    const copies: BrowserRecord[] = [];
    for (const source of sources) {
      const copy = this.createBrowser(source.profileId, {
        url: source.url,
        title: source.title,
        history: clone(source.history),
        zoneId: source.zoneId,
        worldRect: clampWorldRect({ ...source.worldRect, x: source.worldRect.x + 32, y: source.worldRect.y + 24 })
      });
      copies.push(copy);
    }
    return copies;
  }

  removeBrowser(browserId: string): void {
    const browser = this.#browsers.get(browserId);
    if (!browser) return;
    const zoneId = browser.zoneId;
    this.#removeBrowserFromStack(browserId);
    this.#browsers.delete(browserId);
    this.#browserOrder = this.#browserOrder.filter((id) => id !== browserId);
    this.#normalizeZOrder();
    if (this.#selectedBrowserId === browserId) this.#selectedBrowserId = this.#orderedBrowsers().at(-1)?.id ?? null;
    if (zoneId) this.#removeZoneIfEmpty(zoneId);
    this.#touch();
  }

  assignProfile(browserId: string, profileId: string): BrowserRecord {
    const target = this.#requireProfile(profileId);
    const browser = this.#requireBrowser(browserId);
    if (browser.profileId === profileId) return clone(browser);
    const source = this.#requireProfile(browser.profileId);
    const oldZoneId = browser.zoneId;
    this.#removeBrowserFromStack(browserId);
    browser.profileId = target.id;
    browser.zoneId = null;
    browser.pin.viewport = null;
    if (source.kind !== target.kind) {
      browser.history = browser.url === DEFAULT_BROWSER_URL ? { entries: [], index: 0 } : { entries: [{ url: browser.url, title: browser.title }], index: 0 };
    }
    browser.updatedAt = now();
    if (oldZoneId) this.#removeZoneIfEmpty(oldZoneId);
    this.#touch(browser.updatedAt);
    return clone(browser);
  }

  setPresentation(browserIds: readonly string[], presentation: BrowserRecord['presentation']): void {
    const timestamp = now();
    let changed = false;
    for (const browser of this.#requireBrowsers(browserIds)) {
      if (browser.presentation === presentation) continue;
      if (presentation === 'minimized') {
        this.#removeBrowserFromStack(browser.id);
        browser.pin.viewport = null;
      }
      browser.presentation = presentation;
      browser.updatedAt = timestamp;
      changed = true;
    }
    if (changed) this.#touch(timestamp);
  }

  setPositionLocked(browserIds: readonly string[], locked: boolean): void {
    this.#updateBrowsers(browserIds, (browser) => {
      if (browser.positionLocked === locked) return false;
      browser.positionLocked = locked;
      return true;
    });
  }

  setSidebarPinned(browserIds: readonly string[], pinned: boolean): void {
    this.#updateBrowsers(browserIds, (browser) => {
      if (browser.pin.sidebar === pinned) return false;
      browser.pin.sidebar = pinned;
      return true;
    });
  }

  setViewportPin(browserId: string, viewport: NormalizedViewportRect | null): void {
    const browser = this.#requireBrowser(browserId);
    const next = viewport ? normalizedViewportRectSchema.parse(viewport) : null;
    if (JSON.stringify(browser.pin.viewport) === JSON.stringify(next)) return;
    if (next) {
      this.#removeBrowserFromStack(browserId);
      browser.presentation = 'normal';
    }
    browser.pin.viewport = next;
    browser.updatedAt = now();
    this.#touch(browser.updatedAt);
  }

  createZone(profileId: string, nameInput: string, colorInput: string, browserIds: readonly string[]): ZoneRecord {
    this.#requireProfile(profileId);
    const name = zoneNameSchema.parse(nameInput);
    const color = zoneColorSchema.parse(colorInput);
    if ([...this.#zones.values()].some((zone) => zone.profileId === profileId && zone.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) {
      throw new OmniUserError('conflict', `Ya existe una zona llamada “${name}” en este perfil.`);
    }
    const browsers = [...new Set(browserIds)].map((id) => this.#requireBrowser(id));
    if (browsers.length === 0) throw new OmniUserError('invalid-input', 'Selecciona al menos un navegador para crear una zona.');
    if (browsers.some((browser) => browser.profileId !== profileId)) throw new OmniUserError('conflict', 'Todos los navegadores de una zona deben pertenecer al mismo perfil.');
    const timestamp = now();
    const zone = zoneRecordSchema.parse({ id: randomUUID(), profileId, name, color, collapsed: false, createdAt: timestamp, updatedAt: timestamp });
    this.#zones.set(zone.id, zone);
    for (const browser of browsers) {
      const previousZoneId = browser.zoneId;
      this.#removeBrowserFromStack(browser.id);
      browser.zoneId = zone.id;
      browser.updatedAt = timestamp;
      if (previousZoneId) this.#removeZoneIfEmpty(previousZoneId);
    }
    this.#touch(timestamp);
    return clone(zone);
  }

  updateZone(zoneId: string, update: { name?: string; color?: string }): ZoneRecord {
    const zone = this.#requireZone(zoneId);
    const name = update.name === undefined ? undefined : zoneNameSchema.parse(update.name);
    const color = update.color === undefined ? undefined : zoneColorSchema.parse(update.color);
    if (name !== undefined && [...this.#zones.values()].some((candidate) => candidate.id !== zone.id && candidate.profileId === zone.profileId && candidate.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) {
      throw new OmniUserError('conflict', `Ya existe una zona llamada “${name}” en este perfil.`);
    }
    if (name !== undefined) zone.name = name;
    if (color !== undefined) zone.color = color;
    zone.updatedAt = now();
    this.#touch(zone.updatedAt);
    return clone(zone);
  }

  setZoneCollapsed(zoneId: string, collapsed: boolean): void {
    const zone = this.#requireZone(zoneId);
    if (zone.collapsed === collapsed) return;
    zone.collapsed = collapsed;
    zone.updatedAt = now();
    this.#touch(zone.updatedAt);
  }

  deleteZone(zoneId: string): void {
    this.#requireZone(zoneId);
    for (const browser of this.#browsers.values()) if (browser.zoneId === zoneId) browser.zoneId = null;
    for (const [stackId, stack] of this.#stacks) if (stack.zoneId === zoneId) this.#stacks.delete(stackId);
    this.#zones.delete(zoneId);
    this.#touch();
  }

  assignZone(browserIds: readonly string[], zoneId: string | null): void {
    const zone = zoneId ? this.#requireZone(zoneId) : null;
    const browsers = this.#requireBrowsers(browserIds);
    if (zone && browsers.some((browser) => browser.profileId !== zone.profileId)) throw new OmniUserError('conflict', 'La zona pertenece a otro perfil.');
    const timestamp = now();
    const previousZoneIds = new Set<string>();
    for (const browser of browsers) {
      if (browser.zoneId === zoneId) continue;
      if (browser.zoneId) previousZoneIds.add(browser.zoneId);
      this.#removeBrowserFromStack(browser.id);
      browser.zoneId = zoneId;
      browser.updatedAt = timestamp;
    }
    for (const previousZoneId of previousZoneIds) this.#removeZoneIfEmpty(previousZoneId);
    this.#touch(timestamp);
  }

  createStack(zoneId: string, browserIds: readonly string[]): StackRecord {
    const zone = this.#requireZone(zoneId);
    const uniqueIds = [...new Set(browserIds)];
    if (uniqueIds.length < 2) throw new OmniUserError('invalid-input', 'Selecciona al menos dos navegadores para apilarlos.');
    const browsers = uniqueIds.map((id) => this.#requireBrowser(id));
    if (browsers.some((browser) => browser.zoneId !== zone.id || browser.profileId !== zone.profileId)) throw new OmniUserError('conflict', 'Todos los navegadores del stack deben pertenecer a la misma zona.');
    if (browsers.some((browser) => browser.positionLocked)) throw new OmniUserError('conflict', 'Desbloquea los navegadores antes de apilarlos.');
    const targetRect = clone(browsers.at(-1)!.worldRect);
    const timestamp = now();
    for (const browser of browsers) {
      this.#removeBrowserFromStack(browser.id);
      browser.worldRect = clone(targetRect);
      browser.presentation = 'normal';
      browser.pin.viewport = null;
      browser.updatedAt = timestamp;
    }
    const stack = stackRecordSchema.parse({ id: randomUUID(), zoneId, browserIds: uniqueIds, createdAt: timestamp, updatedAt: timestamp });
    this.#stacks.set(stack.id, stack);
    this.focusBrowser(uniqueIds.at(-1)!);
    this.#touch(timestamp);
    return clone(stack);
  }

  addStackMember(stackId: string, browserId: string): void {
    const stack = this.#requireStack(stackId);
    const zone = this.#requireZone(stack.zoneId);
    const browser = this.#requireBrowser(browserId);
    if (browser.zoneId !== zone.id || browser.profileId !== zone.profileId) throw new OmniUserError('conflict', 'El navegador debe pertenecer a la misma zona del stack.');
    if (browser.positionLocked) throw new OmniUserError('conflict', 'Desbloquea el navegador antes de apilarlo.');
    if (stack.browserIds.includes(browserId)) {
      this.selectStackMember(stackId, browserId);
      return;
    }
    this.#removeBrowserFromStack(browserId);
    const top = this.#requireBrowser(stack.browserIds.at(-1)!);
    browser.worldRect = clone(top.worldRect);
    browser.presentation = 'normal';
    browser.pin.viewport = null;
    browser.updatedAt = now();
    stack.browserIds.push(browserId);
    stack.updatedAt = browser.updatedAt;
    this.focusBrowser(browserId);
    this.#touch(browser.updatedAt);
  }

  selectStackMember(stackId: string, browserId: string): void {
    const stack = this.#requireStack(stackId);
    if (!stack.browserIds.includes(browserId)) throw new OmniUserError('conflict', 'El navegador no pertenece a este stack.');
    stack.browserIds = [...stack.browserIds.filter((id) => id !== browserId), browserId];
    stack.updatedAt = now();
    this.focusBrowser(browserId);
    this.#touch(stack.updatedAt);
  }

  unstack(stackId: string): void {
    const stack = this.#requireStack(stackId);
    const timestamp = now();
    stack.browserIds.forEach((browserId, index) => {
      const browser = this.#browsers.get(browserId);
      if (!browser) return;
      browser.worldRect = clampWorldRect({ ...browser.worldRect, x: browser.worldRect.x + index * 28, y: browser.worldRect.y + index * 24 });
      browser.updatedAt = timestamp;
    });
    this.#stacks.delete(stackId);
    this.#touch(timestamp);
  }

  setBrowserOrder(browserOrder: readonly string[]): void {
    if (browserOrder.length !== this.#browsers.size || new Set(browserOrder).size !== this.#browsers.size || browserOrder.some((id) => !this.#browsers.has(id))) {
      throw new OmniUserError('invalid-input', 'El orden debe incluir cada navegador exactamente una vez.');
    }
    if (browserOrder.every((id, index) => id === this.#browserOrder[index])) return;
    this.#browserOrder = [...browserOrder];
    this.#touch();
  }

  setPreferences(update: Partial<WorkspacePreferences>): void {
    const next = { ...this.#preferences, ...update };
    if (next.snapEnabled === this.#preferences.snapEnabled && next.historySwipeEnabled === this.#preferences.historySwipeEnabled) return;
    this.#preferences = next;
    this.#touch();
  }

  setSuspended(browserId: string, suspended: boolean): boolean {
    const browser = this.#requireBrowser(browserId);
    if (browser.suspended === suspended) return false;
    browser.suspended = suspended;
    browser.updatedAt = now();
    this.#touch(browser.updatedAt);
    return true;
  }

  setNavigation(browserId: string, value: { url: string; title: string; history?: { entries: readonly RawHistoryEntry[]; index: number } }): NavigationChange {
    const browser = this.#requireBrowser(browserId);
    const history = value.history ? sanitizeHistory(value.history.entries, value.history.index) : browser.history;
    const activeEntry = history.entries[history.index];
    const url = isPersistableNavigationUrl(value.url) ? value.url : activeEntry?.url ?? browser.url;
    const title = value.title ? value.title.slice(0, MAX_TITLE_LENGTH) : browser.title;
    const locationChanged = browser.url !== url || JSON.stringify(browser.history) !== JSON.stringify(history);
    const titleChanged = browser.title !== title;
    if (!locationChanged && !titleChanged) return 'none';
    browser.url = url;
    browser.title = title;
    browser.history = history;
    browser.updatedAt = now();
    if (this.#requireProfile(browser.profileId).kind === 'persistent') this.#touch(browser.updatedAt);
    return locationChanged ? 'location' : 'title';
  }

  focusBrowser(browserId: string): boolean {
    const browser = this.#requireBrowser(browserId);
    const stack = this.#stackForBrowser(browserId);
    if (stack && stack.browserIds.at(-1) !== browserId) {
      stack.browserIds = [...stack.browserIds.filter((id) => id !== browserId), browserId];
      stack.updatedAt = now();
    }
    const highestZ = this.#browsers.size;
    const changed = this.#selectedBrowserId !== browserId || browser.zIndex !== highestZ;
    if (!changed) return false;
    browser.zIndex = highestZ + 1;
    this.#normalizeZOrder();
    this.#selectedBrowserId = browserId;
    this.#touch();
    return true;
  }

  clearFocus(): boolean {
    if (this.#selectedBrowserId === null) return false;
    this.#selectedBrowserId = null;
    this.#touch();
    return true;
  }

  commitLayout(layout: LayoutBatch): boolean {
    const requested = new Map(layout.items.map((item) => [item.browserId, worldRectSchema.parse(item.worldRect)]));
    const rejected = new Set<string>();
    for (const stack of this.#stacks.values()) {
      const changed = stack.browserIds.some((id) => {
        const current = this.#browsers.get(id);
        const next = requested.get(id);
        return current && next && !sameRect(current.worldRect, next);
      });
      if (!changed) continue;
      const first = requested.get(stack.browserIds[0]!);
      const valid = first
        && stack.browserIds.every((id) => {
          const browser = this.#browsers.get(id);
          const next = requested.get(id);
          return browser && next && !browser.positionLocked && !browser.pin.viewport && sameRect(first, next);
        });
      if (!valid) for (const id of stack.browserIds) rejected.add(id);
    }

    let changed = false;
    const timestamp = now();
    for (const [browserId, requestedRect] of requested) {
      const browser = this.#browsers.get(browserId);
      if (!browser || rejected.has(browserId) || browser.positionLocked || browser.pin.viewport) continue;
      const worldRect = browser.presentation === 'minimized'
        ? { ...requestedRect, width: browser.worldRect.width, height: browser.worldRect.height }
        : requestedRect;
      if (sameRect(browser.worldRect, worldRect)) continue;
      browser.worldRect = worldRect;
      browser.updatedAt = timestamp;
      changed = true;
    }
    if (changed) this.#touch(timestamp);
    return changed;
  }

  setCamera(camera: Camera): boolean {
    const next = cameraSchema.parse(camera);
    if (sameCamera(this.#camera, next)) return false;
    this.#camera = next;
    this.#touch();
    return true;
  }

  setWindowBounds(bounds: NonNullable<WorkspaceFile['windowBounds']>): boolean {
    const current = this.#windowBounds;
    if (current && current.x === bounds.x && current.y === bounds.y && current.width === bounds.width && current.height === bounds.height) return false;
    this.#windowBounds = clone(bounds);
    this.#touch();
    return true;
  }

  toPersistentFile(): WorkspaceFile {
    const profiles = this.listProfiles().filter((profile): profile is ProfileRecord & { kind: 'persistent' } => profile.kind === 'persistent');
    const persistentProfileIds = new Set(profiles.map((profile) => profile.id));
    const browsers = this.listBrowsers().filter((browser) => persistentProfileIds.has(browser.profileId));
    const browserIds = new Set(browsers.map((browser) => browser.id));
    const zones = this.listZones().filter((zone) => persistentProfileIds.has(zone.profileId));
    const zoneIds = new Set(zones.map((zone) => zone.id));
    const stacks = this.listStacks().filter((stack) => zoneIds.has(stack.zoneId) && stack.browserIds.every((id) => browserIds.has(id)));
    return workspaceFileSchema.parse({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      profiles,
      browsers,
      zones,
      stacks,
      browserOrder: this.#browserOrder.filter((id) => browserIds.has(id)),
      preferences: this.#preferences,
      camera: this.#camera,
      selectedBrowserId: this.#selectedBrowserId && browserIds.has(this.#selectedBrowserId) ? this.#selectedBrowserId : null,
      windowBounds: this.#windowBounds,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt
    });
  }

  toBrowserSnapshot(browserId: string, runtimeState?: BrowserRuntimeState): BrowserSnapshot {
    const record = this.#requireBrowser(browserId);
    return {
      id: record.id,
      profileId: record.profileId,
      zoneId: record.zoneId,
      worldRect: clone(record.worldRect),
      zIndex: record.zIndex,
      url: record.url,
      title: record.title,
      suspended: record.suspended,
      presentation: record.presentation,
      positionLocked: record.positionLocked,
      pin: clone(record.pin),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      runtime: clone(runtimeState ?? defaultRuntimeState(record))
    };
  }

  toSnapshot(runtimeStates: ReadonlyMap<string, BrowserRuntimeState>, saveStatus: WorkspaceSnapshot['saveStatus']): WorkspaceSnapshot {
    return {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      profiles: this.listProfiles(),
      browsers: this.#orderedBrowsers().map((browser) => this.toBrowserSnapshot(browser.id, runtimeStates.get(browser.id))),
      zones: this.listZones(),
      stacks: this.listStacks(),
      browserOrder: [...this.#browserOrder],
      preferences: clone(this.#preferences),
      camera: clone(this.#camera),
      selectedBrowserId: this.#selectedBrowserId,
      windowBounds: this.#windowBounds ? clone(this.#windowBounds) : undefined,
      saveStatus,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt
    };
  }

  #orderedBrowsers(): BrowserRecord[] {
    return [...this.#browsers.values()].sort((a, b) => a.zIndex - b.zIndex || a.createdAt.localeCompare(b.createdAt));
  }

  #normalizeZOrder(): void {
    this.#orderedBrowsers().forEach((browser, index) => { browser.zIndex = index + 1; });
  }

  #updateBrowsers(browserIds: readonly string[], update: (browser: BrowserRecord) => boolean): void {
    const timestamp = now();
    let changed = false;
    for (const browser of this.#requireBrowsers(browserIds)) {
      if (!update(browser)) continue;
      browser.updatedAt = timestamp;
      changed = true;
    }
    if (changed) this.#touch(timestamp);
  }

  #stackForBrowser(browserId: string): StackRecord | undefined {
    return [...this.#stacks.values()].find((stack) => stack.browserIds.includes(browserId));
  }

  #removeBrowserFromStack(browserId: string): void {
    const stack = this.#stackForBrowser(browserId);
    if (!stack) return;
    stack.browserIds = stack.browserIds.filter((id) => id !== browserId);
    if (stack.browserIds.length < 2) this.#stacks.delete(stack.id);
    else stack.updatedAt = now();
  }

  #removeZoneIfEmpty(zoneId: string): void {
    if ([...this.#browsers.values()].some((browser) => browser.zoneId === zoneId)) return;
    for (const [stackId, stack] of this.#stacks) if (stack.zoneId === zoneId) this.#stacks.delete(stackId);
    this.#zones.delete(zoneId);
  }

  #hasProfileNamed(name: string): boolean {
    return [...this.#profiles.values()].some((profile) => profile.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0);
  }

  #uniqueProfileName(base: string): string {
    if (!this.#hasProfileNamed(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base} ${suffix}`;
      if (!this.#hasProfileNamed(candidate)) return candidate;
    }
  }

  #requireProfile(profileId: string): ProfileRecord {
    const profile = this.#profiles.get(profileId);
    if (!profile) throw new ProfileNotFoundError();
    return profile;
  }

  #requireBrowser(browserId: string): BrowserRecord {
    const browser = this.#browsers.get(browserId);
    if (!browser) throw new BrowserNotFoundError();
    return browser;
  }

  #requireBrowsers(browserIds: readonly string[]): BrowserRecord[] {
    return [...new Set(browserIds)].map((browserId) => this.#requireBrowser(browserId));
  }

  #requireZone(zoneId: string): ZoneRecord {
    const zone = this.#zones.get(zoneId);
    if (!zone) throw new OmniUserError('not-found', 'La zona ya no existe.');
    return zone;
  }

  #requireStack(stackId: string): StackRecord {
    const stack = this.#stacks.get(stackId);
    if (!stack) throw new OmniUserError('not-found', 'El stack ya no existe.');
    return stack;
  }

  #touch(timestamp = now()): void {
    this.#updatedAt = timestamp;
  }
}
