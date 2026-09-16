import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BROWSER_URL,
  MAX_TITLE_LENGTH,
  WORKSPACE_SCHEMA_VERSION
} from '../../shared/constants';
import { OmniUserError } from '../../shared/errors';
import {
  browserRecordSchema,
  cameraSchema,
  profileNameSchema,
  profileSchema,
  workspaceFileSchema,
  worldRectSchema,
  type BrowserRecord,
  type BrowserRuntimeState,
  type BrowserSnapshot,
  type Camera,
  type LayoutBatch,
  type ProfileRecord,
  type WorkspaceFile,
  type WorkspaceSnapshot,
  type WorldRect
} from '../../shared/schemas';
import { isPersistableNavigationUrl } from '../../shared/urls';
import { sanitizeHistory, type RawHistoryEntry } from './navigation-history';

export type NavigationChange = 'none' | 'title' | 'location';

const defaultRuntimeState = (record: BrowserRecord): BrowserRuntimeState => ({
  isAwake: !record.suspended,
  isLoading: false,
  canGoBack: record.history.index > 0,
  canGoForward: record.history.entries.length > 0 && record.history.index < record.history.entries.length - 1,
  crashed: false
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
    worldRect: { x: 72, y: 72, width: 640, height: 440 },
    zIndex: 1,
    url: DEFAULT_BROWSER_URL,
    title: 'Nueva página',
    history: { entries: [], index: 0 },
    suspended: false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  return workspaceFileSchema.parse({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    profiles: [personalProfile],
    browsers: [firstBrowser],
    camera: { panX: 0, panY: 0, zoom: 0.82 },
    selectedBrowserId: firstBrowser.id,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export class WorkspaceModel {
  readonly #profiles = new Map<string, ProfileRecord>();
  readonly #browsers = new Map<string, BrowserRecord>();
  #camera: Camera;
  #selectedBrowserId: string | null;
  #windowBounds: WorkspaceFile['windowBounds'];
  readonly #createdAt: string;
  #updatedAt: string;

  constructor(file: WorkspaceFile, temporaryProfileName = 'Temporal') {
    const parsed = workspaceFileSchema.parse(file);
    for (const profile of parsed.profiles) this.#profiles.set(profile.id, clone(profile));
    for (const browser of parsed.browsers) this.#browsers.set(browser.id, clone(browser));
    this.#camera = clone(parsed.camera);
    this.#selectedBrowserId = parsed.selectedBrowserId;
    this.#windowBounds = parsed.windowBounds ? clone(parsed.windowBounds) : undefined;
    this.#createdAt = parsed.createdAt;
    this.#updatedAt = parsed.updatedAt;
    this.#normalizeZOrder();
    this.createProfile(this.#uniqueProfileName(temporaryProfileName), 'temporary');
  }

  listProfiles(): ProfileRecord[] {
    return [...this.#profiles.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone);
  }

  listBrowsers(): BrowserRecord[] {
    return this.#orderedBrowsers().map(clone);
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

  createBrowser(profileId: string, options: { url?: string; worldRect?: WorldRect; title?: string; suspended?: boolean } = {}): BrowserRecord {
    this.#requireProfile(profileId);
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
      worldRect,
      zIndex: existingCount + 1,
      url: options.url && isPersistableNavigationUrl(options.url) ? options.url : DEFAULT_BROWSER_URL,
      title: (options.title ?? 'Nueva página').slice(0, MAX_TITLE_LENGTH),
      history: { entries: [], index: 0 },
      suspended: options.suspended ?? false,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.#browsers.set(browser.id, browser);
    this.#selectedBrowserId = browser.id;
    this.#normalizeZOrder();
    this.#touch(timestamp);
    return clone(browser);
  }

  removeBrowser(browserId: string): void {
    if (!this.#browsers.delete(browserId)) return;
    this.#normalizeZOrder();
    if (this.#selectedBrowserId === browserId) {
      this.#selectedBrowserId = this.#orderedBrowsers().at(-1)?.id ?? null;
    }
    this.#touch();
  }

  assignProfile(browserId: string, profileId: string): BrowserRecord {
    this.#requireProfile(profileId);
    const browser = this.#requireBrowser(browserId);
    browser.profileId = profileId;
    browser.updatedAt = now();
    this.#touch(browser.updatedAt);
    return clone(browser);
  }

  /** Returns whether the persisted suspension flag changed. */
  setSuspended(browserId: string, suspended: boolean): boolean {
    const browser = this.#requireBrowser(browserId);
    if (browser.suspended === suspended) return false;
    browser.suspended = suspended;
    browser.updatedAt = now();
    this.#touch(browser.updatedAt);
    return true;
  }

  /**
   * Records navigation state captured from Chromium. Entries that cannot be persisted are dropped and the URL falls back
   * to the active retained entry, so a hostile or merely long URL can never make the workspace unserializable.
   * Reports whether the location/history changed, only the title changed, or nothing changed.
   */
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
    this.#touch(browser.updatedAt);
    return locationChanged ? 'location' : 'title';
  }

  /** Selects a browser and raises it above every other one. Returns whether selection or z-order changed. */
  focusBrowser(browserId: string): boolean {
    const browser = this.#requireBrowser(browserId);
    const highestZ = this.#browsers.size;
    const changed = this.#selectedBrowserId !== browserId || browser.zIndex !== highestZ;
    if (!changed) return false;
    browser.zIndex = highestZ + 1;
    this.#normalizeZOrder();
    this.#selectedBrowserId = browserId;
    this.#touch();
    return true;
  }

  /** Applies world geometry reported by the shell. Returns whether any persisted rectangle changed. */
  commitLayout(layout: LayoutBatch): boolean {
    let changed = false;
    const timestamp = now();
    for (const item of layout.items) {
      const browser = this.#browsers.get(item.browserId);
      if (!browser) continue;
      const worldRect = worldRectSchema.parse(item.worldRect);
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
    return workspaceFileSchema.parse({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      profiles,
      browsers,
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
      worldRect: { ...record.worldRect },
      zIndex: record.zIndex,
      url: record.url,
      title: record.title,
      suspended: record.suspended,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      runtime: { ...(runtimeState ?? defaultRuntimeState(record)) }
    };
  }

  toSnapshot(runtimeStates: ReadonlyMap<string, BrowserRuntimeState>, saveStatus: WorkspaceSnapshot['saveStatus']): WorkspaceSnapshot {
    return {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      profiles: this.listProfiles(),
      browsers: this.#orderedBrowsers().map((browser) => this.toBrowserSnapshot(browser.id, runtimeStates.get(browser.id))),
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

  /** Keeps z-order dense (1..n) so repeated focus operations can never exceed the schema bounds. */
  #normalizeZOrder(): void {
    this.#orderedBrowsers().forEach((browser, index) => {
      browser.zIndex = index + 1;
    });
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

  #touch(timestamp = now()): void {
    this.#updatedAt = timestamp;
  }
}
