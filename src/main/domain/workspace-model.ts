import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BROWSER_URL,
  MIN_BROWSER_HEIGHT,
  MIN_BROWSER_WIDTH,
  WORKSPACE_SCHEMA_VERSION
} from '../../shared/constants';
import {
  browserRecordSchema,
  cameraSchema,
  profileNameSchema,
  profileSchema,
  workspaceFileSchema,
  worldRectSchema,
  type BrowserRecord,
  type BrowserRuntimeState,
  type Camera,
  type LayoutBatch,
  type NavigationHistoryRecord,
  type ProfileRecord,
  type WorkspaceFile,
  type WorkspaceSnapshot,
  type WorldRect
} from '../../shared/schemas';

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
    this.createProfile(temporaryProfileName, 'temporary');
  }

  listProfiles(): ProfileRecord[] {
    return [...this.#profiles.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone);
  }

  listBrowsers(): BrowserRecord[] {
    return [...this.#browsers.values()].sort((a, b) => a.zIndex - b.zIndex).map(clone);
  }

  get selectedBrowserId(): string | null {
    return this.#selectedBrowserId;
  }

  getProfile(profileId: string): ProfileRecord {
    const profile = this.#profiles.get(profileId);
    if (!profile) throw new Error(`Profile ${profileId} does not exist.`);
    return clone(profile);
  }

  getBrowser(browserId: string): BrowserRecord {
    const browser = this.#browsers.get(browserId);
    if (!browser) throw new Error(`Browser ${browserId} does not exist.`);
    return clone(browser);
  }

  hasBrowser(browserId: string): boolean {
    return this.#browsers.has(browserId);
  }

  createProfile(nameInput: string, kind: ProfileRecord['kind']): ProfileRecord {
    const name = profileNameSchema.parse(nameInput);
    const duplicate = [...this.#profiles.values()].some((profile) => profile.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0);
    if (duplicate) throw new Error(`Ya existe un perfil llamado “${name}”.`);
    const timestamp = now();
    const profile = profileSchema.parse({ id: randomUUID(), name, kind, createdAt: timestamp, updatedAt: timestamp });
    this.#profiles.set(profile.id, profile);
    this.touch(timestamp);
    return clone(profile);
  }

  createBrowser(profileId: string, options: { url?: string; worldRect?: WorldRect; title?: string; suspended?: boolean } = {}): BrowserRecord {
    this.getProfile(profileId);
    const timestamp = now();
    const existingCount = this.#browsers.size;
    const highestZ = Math.max(0, ...[...this.#browsers.values()].map((browser) => browser.zIndex));
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
      zIndex: highestZ + 1,
      url: options.url ?? DEFAULT_BROWSER_URL,
      title: options.title ?? 'Nueva página',
      history: { entries: [], index: 0 },
      suspended: options.suspended ?? false,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.#browsers.set(browser.id, browser);
    this.#selectedBrowserId = browser.id;
    this.touch(timestamp);
    return clone(browser);
  }

  removeBrowser(browserId: string): void {
    if (!this.#browsers.delete(browserId)) return;
    if (this.#selectedBrowserId === browserId) {
      this.#selectedBrowserId = this.listBrowsers().at(-1)?.id ?? null;
    }
    this.touch();
  }

  assignProfile(browserId: string, profileId: string): BrowserRecord {
    this.getProfile(profileId);
    const browser = this.requireMutableBrowser(browserId);
    browser.profileId = profileId;
    browser.updatedAt = now();
    this.touch(browser.updatedAt);
    return clone(browser);
  }

  setSuspended(browserId: string, suspended: boolean): BrowserRecord {
    const browser = this.requireMutableBrowser(browserId);
    browser.suspended = suspended;
    browser.updatedAt = now();
    this.touch(browser.updatedAt);
    return clone(browser);
  }

  setNavigation(browserId: string, value: { url: string; title: string; history?: NavigationHistoryRecord }): BrowserRecord {
    const browser = this.requireMutableBrowser(browserId);
    browser.url = value.url;
    browser.title = value.title.slice(0, 512);
    if (value.history) browser.history = clone(value.history);
    browser.updatedAt = now();
    this.touch(browser.updatedAt);
    return clone(browser);
  }

  focusBrowser(browserId: string): BrowserRecord {
    const browser = this.requireMutableBrowser(browserId);
    const highestZ = Math.max(0, ...[...this.#browsers.values()].map((candidate) => candidate.zIndex));
    if (browser.zIndex !== highestZ) browser.zIndex = highestZ + 1;
    browser.updatedAt = now();
    this.#selectedBrowserId = browserId;
    this.touch(browser.updatedAt);
    return clone(browser);
  }

  commitLayout(layout: LayoutBatch): void {
    for (const item of layout.items) {
      const browser = this.#browsers.get(item.browserId);
      if (!browser) continue;
      browser.worldRect = worldRectSchema.parse(item.worldRect);
      browser.zIndex = item.zIndex;
      browser.updatedAt = now();
    }
    this.touch();
  }

  setCamera(camera: Camera): void {
    this.#camera = cameraSchema.parse(camera);
    this.touch();
  }

  setWindowBounds(bounds: NonNullable<WorkspaceFile['windowBounds']>): void {
    this.#windowBounds = clone(bounds);
    this.touch();
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

  toSnapshot(runtimeStates: ReadonlyMap<string, BrowserRuntimeState>, saveStatus: WorkspaceSnapshot['saveStatus']): WorkspaceSnapshot {
    return {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      profiles: this.listProfiles(),
      browsers: this.listBrowsers().map((browser) => ({
        ...browser,
        runtime: clone(runtimeStates.get(browser.id) ?? defaultRuntimeState(browser))
      })),
      camera: clone(this.#camera),
      selectedBrowserId: this.#selectedBrowserId,
      windowBounds: this.#windowBounds ? clone(this.#windowBounds) : undefined,
      saveStatus,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt
    };
  }

  private requireMutableBrowser(browserId: string): BrowserRecord {
    const browser = this.#browsers.get(browserId);
    if (!browser) throw new Error(`Browser ${browserId} does not exist.`);
    return browser;
  }

  private touch(timestamp = now()): void {
    this.#updatedAt = timestamp;
  }
}

export function minimumBrowserRect(rect: Partial<WorldRect>): WorldRect {
  return worldRectSchema.parse({
    x: rect.x ?? 0,
    y: rect.y ?? 0,
    width: Math.max(MIN_BROWSER_WIDTH, rect.width ?? MIN_BROWSER_WIDTH),
    height: Math.max(MIN_BROWSER_HEIGHT, rect.height ?? MIN_BROWSER_HEIGHT)
  });
}
