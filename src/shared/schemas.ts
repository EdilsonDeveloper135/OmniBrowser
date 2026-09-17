import { z } from 'zod';
import {
  DEFAULT_BROWSER_URL,
  MAX_BROWSER_COUNT_PER_LAYOUT_BATCH,
  MAX_CAMERA_PAN,
  MAX_HISTORY_ENTRIES,
  MAX_SCREEN_COORDINATE,
  MAX_SCREEN_SIZE,
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
  MAX_WORLD_COORDINATE,
  MAX_WORLD_SIZE,
  MAX_ZOOM,
  MIN_BROWSER_HEIGHT,
  MIN_BROWSER_WIDTH,
  MIN_ZOOM,
  WORKSPACE_SCHEMA_VERSION
} from './constants';

export const uuidSchema = z.string().uuid();
export const isoDateSchema = z.string().datetime({ offset: true });
export const profileNameSchema = z.string().trim().min(1).max(48);
export const zoneNameSchema = z.string().trim().min(1).max(64);
export const zoneColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

export const profileSchema = z.object({
  id: uuidSchema,
  name: profileNameSchema,
  kind: z.enum(['persistent', 'private']),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
}).strict();

export const persistentProfileSchema = profileSchema.extend({ kind: z.literal('persistent') }).strict();

export const worldRectSchema = z.object({
  x: z.number().finite().min(-MAX_WORLD_COORDINATE).max(MAX_WORLD_COORDINATE),
  y: z.number().finite().min(-MAX_WORLD_COORDINATE).max(MAX_WORLD_COORDINATE),
  width: z.number().finite().min(MIN_BROWSER_WIDTH).max(MAX_WORLD_SIZE),
  height: z.number().finite().min(MIN_BROWSER_HEIGHT).max(MAX_WORLD_SIZE)
}).strict();

export const screenRectSchema = z.object({
  x: z.number().int().min(-MAX_SCREEN_COORDINATE).max(MAX_SCREEN_COORDINATE),
  y: z.number().int().min(-MAX_SCREEN_COORDINATE).max(MAX_SCREEN_COORDINATE),
  width: z.number().int().min(1).max(MAX_SCREEN_SIZE),
  height: z.number().int().min(1).max(MAX_SCREEN_SIZE)
}).strict();

export const normalizedViewportRectSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().min(0.05).max(1),
  height: z.number().finite().min(0.05).max(1)
}).strict().superRefine((rect, context) => {
  if (rect.x + rect.width > 1.000_001) context.addIssue({ code: 'custom', message: 'El pin horizontal queda fuera del viewport.', path: ['width'] });
  if (rect.y + rect.height > 1.000_001) context.addIssue({ code: 'custom', message: 'El pin vertical queda fuera del viewport.', path: ['height'] });
});

export const cameraSchema = z.object({
  panX: z.number().finite().min(-MAX_CAMERA_PAN).max(MAX_CAMERA_PAN),
  panY: z.number().finite().min(-MAX_CAMERA_PAN).max(MAX_CAMERA_PAN),
  zoom: z.number().finite().min(MIN_ZOOM).max(MAX_ZOOM)
}).strict();

export const historyEntrySchema = z.object({
  url: z.string().min(1).max(MAX_URL_LENGTH),
  title: z.string().max(MAX_TITLE_LENGTH)
}).strict();

export const navigationHistorySchema = z.object({
  entries: z.array(historyEntrySchema).max(MAX_HISTORY_ENTRIES),
  index: z.number().int().min(0).max(MAX_HISTORY_ENTRIES - 1)
}).strict();

export const browserPinSchema = z.object({
  sidebar: z.boolean(),
  viewport: normalizedViewportRectSchema.nullable()
}).strict();

export const browserRecordSchema = z.object({
  id: uuidSchema,
  profileId: uuidSchema,
  zoneId: uuidSchema.nullable(),
  worldRect: worldRectSchema,
  zIndex: z.number().int().min(0).max(1_000_000),
  url: z.string().min(1).max(MAX_URL_LENGTH).default(DEFAULT_BROWSER_URL),
  title: z.string().max(MAX_TITLE_LENGTH),
  history: navigationHistorySchema,
  suspended: z.boolean(),
  presentation: z.enum(['normal', 'minimized']),
  positionLocked: z.boolean(),
  pin: browserPinSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
}).strict();

export const zoneRecordSchema = z.object({
  id: uuidSchema,
  profileId: uuidSchema,
  name: zoneNameSchema,
  color: zoneColorSchema,
  collapsed: z.boolean(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
}).strict();

export const stackRecordSchema = z.object({
  id: uuidSchema,
  zoneId: uuidSchema,
  browserIds: z.array(uuidSchema).min(2).max(500),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
}).strict();

export const workspacePreferencesSchema = z.object({
  snapEnabled: z.boolean(),
  historySwipeEnabled: z.boolean()
}).strict();

export const windowBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(800),
  height: z.number().int().min(600)
}).strict();

type RelationalWorkspace = {
  profiles: Array<{ id: string }>;
  browsers: Array<{ id: string; profileId: string; zoneId: string | null }>;
  zones: Array<{ id: string; profileId: string }>;
  stacks: Array<{ id: string; zoneId: string; browserIds: string[] }>;
  browserOrder: string[];
  selectedBrowserId: string | null;
};

function refineWorkspaceRelations(workspace: RelationalWorkspace, context: z.RefinementCtx): void {
  const profileIds = new Set<string>();
  for (const profile of workspace.profiles) {
    if (profileIds.has(profile.id)) context.addIssue({ code: 'custom', message: `Duplicate profile id: ${profile.id}`, path: ['profiles'] });
    profileIds.add(profile.id);
  }

  const zoneById = new Map<string, RelationalWorkspace['zones'][number]>();
  for (const zone of workspace.zones) {
    if (zoneById.has(zone.id)) context.addIssue({ code: 'custom', message: `Duplicate zone id: ${zone.id}`, path: ['zones'] });
    zoneById.set(zone.id, zone);
    if (!profileIds.has(zone.profileId)) context.addIssue({ code: 'custom', message: `Zone ${zone.id} references a missing profile.`, path: ['zones'] });
  }

  const browserById = new Map<string, RelationalWorkspace['browsers'][number]>();
  for (const browser of workspace.browsers) {
    if (browserById.has(browser.id)) context.addIssue({ code: 'custom', message: `Duplicate browser id: ${browser.id}`, path: ['browsers'] });
    browserById.set(browser.id, browser);
    if (!profileIds.has(browser.profileId)) context.addIssue({ code: 'custom', message: `Browser ${browser.id} references a missing profile.`, path: ['browsers'] });
    if (browser.zoneId) {
      const zone = zoneById.get(browser.zoneId);
      if (!zone) context.addIssue({ code: 'custom', message: `Browser ${browser.id} references a missing zone.`, path: ['browsers'] });
      else if (zone.profileId !== browser.profileId) context.addIssue({ code: 'custom', message: `Browser ${browser.id} and its zone use different profiles.`, path: ['browsers'] });
    }
  }

  const stackIds = new Set<string>();
  const stackedBrowserIds = new Set<string>();
  for (const stack of workspace.stacks) {
    if (stackIds.has(stack.id)) context.addIssue({ code: 'custom', message: `Duplicate stack id: ${stack.id}`, path: ['stacks'] });
    stackIds.add(stack.id);
    const zone = zoneById.get(stack.zoneId);
    if (!zone) context.addIssue({ code: 'custom', message: `Stack ${stack.id} references a missing zone.`, path: ['stacks'] });
    const localIds = new Set<string>();
    for (const browserId of stack.browserIds) {
      if (localIds.has(browserId)) context.addIssue({ code: 'custom', message: `Stack ${stack.id} repeats browser ${browserId}.`, path: ['stacks'] });
      localIds.add(browserId);
      if (stackedBrowserIds.has(browserId)) context.addIssue({ code: 'custom', message: `Browser ${browserId} belongs to more than one stack.`, path: ['stacks'] });
      stackedBrowserIds.add(browserId);
      const browser = browserById.get(browserId);
      if (!browser) context.addIssue({ code: 'custom', message: `Stack ${stack.id} references a missing browser.`, path: ['stacks'] });
      else if (browser.zoneId !== stack.zoneId || (zone && browser.profileId !== zone.profileId)) {
        context.addIssue({ code: 'custom', message: `Stack ${stack.id} contains a browser outside its zone.`, path: ['stacks'] });
      }
    }
  }

  const orderedIds = new Set<string>();
  for (const browserId of workspace.browserOrder) {
    if (orderedIds.has(browserId)) context.addIssue({ code: 'custom', message: `browserOrder repeats ${browserId}.`, path: ['browserOrder'] });
    orderedIds.add(browserId);
    if (!browserById.has(browserId)) context.addIssue({ code: 'custom', message: `browserOrder references missing browser ${browserId}.`, path: ['browserOrder'] });
  }
  if (orderedIds.size !== browserById.size) context.addIssue({ code: 'custom', message: 'browserOrder must contain every browser exactly once.', path: ['browserOrder'] });
  if (workspace.selectedBrowserId !== null && !browserById.has(workspace.selectedBrowserId)) {
    context.addIssue({ code: 'custom', message: 'The selected browser does not exist.', path: ['selectedBrowserId'] });
  }
}

export const workspaceFileSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  profiles: z.array(persistentProfileSchema).min(1).max(100),
  browsers: z.array(browserRecordSchema).max(500),
  zones: z.array(zoneRecordSchema).max(500),
  stacks: z.array(stackRecordSchema).max(250),
  browserOrder: z.array(uuidSchema).max(500),
  preferences: workspacePreferencesSchema,
  camera: cameraSchema,
  selectedBrowserId: uuidSchema.nullable(),
  windowBounds: windowBoundsSchema.optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
}).strict().superRefine(refineWorkspaceRelations);

export const downloadRuntimeStateSchema = z.object({
  activeCount: z.number().int().min(0).max(100),
  receivedBytes: z.number().finite().min(0),
  totalBytes: z.number().finite().min(0).nullable(),
  status: z.enum(['idle', 'active', 'interrupted'])
}).strict();

export const browserRuntimeStateSchema = z.object({
  isAwake: z.boolean(),
  isLoading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  crashed: z.boolean(),
  isAudible: z.boolean(),
  faviconKey: z.string().max(200).nullable(),
  download: downloadRuntimeStateSchema,
  lastError: z.enum(['navigation', 'crashed', 'download']).nullable()
}).strict();

export const browserSnapshotSchema = browserRecordSchema.omit({ history: true }).extend({ runtime: browserRuntimeStateSchema }).strict();

export const workspaceSnapshotSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  profiles: z.array(profileSchema),
  browsers: z.array(browserSnapshotSchema),
  zones: z.array(zoneRecordSchema),
  stacks: z.array(stackRecordSchema),
  browserOrder: z.array(uuidSchema).max(500),
  preferences: workspacePreferencesSchema,
  camera: cameraSchema,
  selectedBrowserId: uuidSchema.nullable(),
  windowBounds: windowBoundsSchema.optional(),
  saveStatus: z.enum(['saved', 'saving', 'error']),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
}).strict().superRefine(refineWorkspaceRelations);

export const profileIdInputSchema = z.object({ profileId: uuidSchema }).strict();
export const createProfileInputSchema = z.object({ name: profileNameSchema }).strict();
export const browserIdInputSchema = z.object({ browserId: uuidSchema }).strict();
export const browserIdsInputSchema = z.object({ browserIds: z.array(uuidSchema).min(1).max(500) }).strict();
export const createBrowserInputSchema = z.object({ profileId: uuidSchema }).strict();
export const assignProfileInputSchema = z.object({ browserId: uuidSchema, profileId: uuidSchema }).strict();
export const navigateInputSchema = z.object({ browserId: uuidSchema, url: z.string().max(MAX_URL_LENGTH * 2) }).strict();
export const focusInputSchema = z.object({ browserId: uuidSchema, focusContents: z.boolean().optional() }).strict();
export const cameraInputSchema = z.object({ camera: cameraSchema }).strict();
export const setPresentationInputSchema = z.object({ browserIds: z.array(uuidSchema).min(1).max(500), presentation: z.enum(['normal', 'minimized']) }).strict();
export const setPositionLockedInputSchema = z.object({ browserIds: z.array(uuidSchema).min(1).max(500), locked: z.boolean() }).strict();
export const setSidebarPinnedInputSchema = z.object({ browserIds: z.array(uuidSchema).min(1).max(500), pinned: z.boolean() }).strict();
export const setViewportPinInputSchema = z.object({ browserId: uuidSchema, viewport: normalizedViewportRectSchema.nullable() }).strict();
export const createZoneInputSchema = z.object({ profileId: uuidSchema, name: zoneNameSchema, color: zoneColorSchema, browserIds: z.array(uuidSchema).min(1).max(500) }).strict();
export const updateZoneInputSchema = z.object({ zoneId: uuidSchema, name: zoneNameSchema.optional(), color: zoneColorSchema.optional() }).strict().refine((value) => value.name !== undefined || value.color !== undefined, { message: 'No hay cambios para la zona.' });
export const setZoneCollapsedInputSchema = z.object({ zoneId: uuidSchema, collapsed: z.boolean() }).strict();
export const zoneIdInputSchema = z.object({ zoneId: uuidSchema }).strict();
export const assignZoneInputSchema = z.object({ browserIds: z.array(uuidSchema).min(1).max(500), zoneId: uuidSchema.nullable() }).strict();
export const createStackInputSchema = z.object({ zoneId: uuidSchema, browserIds: z.array(uuidSchema).min(2).max(500) }).strict();
export const addStackMemberInputSchema = z.object({ stackId: uuidSchema, browserId: uuidSchema }).strict();
export const selectStackMemberInputSchema = z.object({ stackId: uuidSchema, browserId: uuidSchema }).strict();
export const stackIdInputSchema = z.object({ stackId: uuidSchema }).strict();
export const setBrowserOrderInputSchema = z.object({ browserOrder: z.array(uuidSchema).max(500) }).strict();
// History swipe stays behind the trackpad compatibility gate (docs/architecture.md): Electron cannot cancel wheel input
// before a WebContentsView handles it, so no client may enable the preference until a gesture router ships.
export const setPreferencesInputSchema = z.object({ snapEnabled: z.boolean().optional(), historySwipeEnabled: z.literal(false).optional() }).strict().refine((value) => value.snapEnabled !== undefined || value.historySwipeEnabled !== undefined, { message: 'No hay preferencias para actualizar.' });

export const layoutItemSchema = z.object({
  browserId: uuidSchema,
  worldRect: worldRectSchema,
  screenBounds: screenRectSchema,
  visible: z.boolean(),
  surfaceLayer: z.enum(['normal', 'pinned', 'immersive']).optional()
}).strict();

export const layoutBatchSchema = z.object({ items: z.array(layoutItemSchema).max(MAX_BROWSER_COUNT_PER_LAYOUT_BATCH) }).strict();

export type ProfileRecord = z.infer<typeof profileSchema>;
export type PersistentProfileRecord = z.infer<typeof persistentProfileSchema>;
export type WorldRect = z.infer<typeof worldRectSchema>;
export type ScreenRect = z.infer<typeof screenRectSchema>;
export type NormalizedViewportRect = z.infer<typeof normalizedViewportRectSchema>;
export type Camera = z.infer<typeof cameraSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type NavigationHistoryRecord = z.infer<typeof navigationHistorySchema>;
export type BrowserRecord = z.infer<typeof browserRecordSchema>;
export type ZoneRecord = z.infer<typeof zoneRecordSchema>;
export type StackRecord = z.infer<typeof stackRecordSchema>;
export type WorkspacePreferences = z.infer<typeof workspacePreferencesSchema>;
export type BrowserRuntimeState = z.infer<typeof browserRuntimeStateSchema>;
export type BrowserSnapshot = z.infer<typeof browserSnapshotSchema>;
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type LayoutItem = z.infer<typeof layoutItemSchema>;
export type LayoutBatch = z.infer<typeof layoutBatchSchema>;
