import { z } from 'zod';
import {
  DEFAULT_BROWSER_URL,
  MAX_BROWSER_COUNT_PER_LAYOUT_BATCH,
  MAX_ZOOM,
  MIN_BROWSER_HEIGHT,
  MIN_BROWSER_WIDTH,
  MIN_ZOOM,
  WORKSPACE_SCHEMA_VERSION
} from './constants';

export const uuidSchema = z.string().uuid();
export const isoDateSchema = z.string().datetime({ offset: true });
export const profileNameSchema = z.string().trim().min(1).max(48);

export const profileSchema = z.object({
  id: uuidSchema,
  name: profileNameSchema,
  kind: z.enum(['persistent', 'temporary']),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
}).strict();

export const persistentProfileSchema = profileSchema.extend({
  kind: z.literal('persistent')
}).strict();

export const worldRectSchema = z.object({
  x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000),
  width: z.number().finite().min(MIN_BROWSER_WIDTH).max(100_000),
  height: z.number().finite().min(MIN_BROWSER_HEIGHT).max(100_000)
}).strict();

export const screenRectSchema = z.object({
  x: z.number().int().min(-100_000).max(100_000),
  y: z.number().int().min(-100_000).max(100_000),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000)
}).strict();

export const cameraSchema = z.object({
  panX: z.number().finite().min(-1_000_000).max(1_000_000),
  panY: z.number().finite().min(-1_000_000).max(1_000_000),
  zoom: z.number().finite().min(MIN_ZOOM).max(MAX_ZOOM)
}).strict();

export const historyEntrySchema = z.object({
  url: z.string().min(1).max(4096),
  title: z.string().max(512)
}).strict();

export const navigationHistorySchema = z.object({
  entries: z.array(historyEntrySchema).max(500),
  index: z.number().int().min(0).max(499)
}).strict();

export const browserRecordSchema = z.object({
  id: uuidSchema,
  profileId: uuidSchema,
  worldRect: worldRectSchema,
  zIndex: z.number().int().min(0).max(1_000_000),
  url: z.string().min(1).max(4096).default(DEFAULT_BROWSER_URL),
  title: z.string().max(512),
  history: navigationHistorySchema,
  suspended: z.boolean(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
}).strict();

export const windowBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(800),
  height: z.number().int().min(600)
}).strict();

export const workspaceFileSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  profiles: z.array(persistentProfileSchema).min(1).max(100),
  browsers: z.array(browserRecordSchema).max(500),
  camera: cameraSchema,
  selectedBrowserId: uuidSchema.nullable(),
  windowBounds: windowBoundsSchema.optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
}).strict().superRefine((workspace, context) => {
  const profileIds = new Set(workspace.profiles.map((profile) => profile.id));
  const browserIds = new Set();
  for (const browser of workspace.browsers) {
    if (browserIds.has(browser.id)) {
      context.addIssue({ code: 'custom', message: `Duplicate browser id: ${browser.id}`, path: ['browsers'] });
    }
    browserIds.add(browser.id);
    if (!profileIds.has(browser.profileId)) {
      context.addIssue({ code: 'custom', message: `Browser ${browser.id} references a missing profile.`, path: ['browsers'] });
    }
  }
  if (workspace.selectedBrowserId !== null && !browserIds.has(workspace.selectedBrowserId)) {
    context.addIssue({ code: 'custom', message: 'The selected browser does not exist.', path: ['selectedBrowserId'] });
  }
});

export const browserRuntimeStateSchema = z.object({
  isAwake: z.boolean(),
  isLoading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  crashed: z.boolean()
}).strict();

export const browserSnapshotSchema = browserRecordSchema.extend({
  runtime: browserRuntimeStateSchema
}).strict();

export const workspaceSnapshotSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  profiles: z.array(profileSchema),
  browsers: z.array(browserSnapshotSchema),
  camera: cameraSchema,
  selectedBrowserId: uuidSchema.nullable(),
  windowBounds: windowBoundsSchema.optional(),
  saveStatus: z.enum(['saved', 'saving', 'error']),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
}).strict();

export const profileIdInputSchema = z.object({ profileId: uuidSchema }).strict();
export const createProfileInputSchema = z.object({ name: profileNameSchema }).strict();
export const browserIdInputSchema = z.object({ browserId: uuidSchema }).strict();
export const createBrowserInputSchema = z.object({ profileId: uuidSchema }).strict();
export const assignProfileInputSchema = z.object({ browserId: uuidSchema, profileId: uuidSchema }).strict();
export const navigateInputSchema = z.object({ browserId: uuidSchema, url: z.string().trim().min(1).max(4096) }).strict();
export const cameraInputSchema = z.object({ camera: cameraSchema }).strict();

export const layoutItemSchema = z.object({
  browserId: uuidSchema,
  worldRect: worldRectSchema,
  zIndex: z.number().int().min(0).max(1_000_000),
  screenBounds: screenRectSchema,
  visible: z.boolean()
}).strict();

export const layoutBatchSchema = z.object({
  items: z.array(layoutItemSchema).max(MAX_BROWSER_COUNT_PER_LAYOUT_BATCH)
}).strict();

export type ProfileRecord = z.infer<typeof profileSchema>;
export type PersistentProfileRecord = z.infer<typeof persistentProfileSchema>;
export type WorldRect = z.infer<typeof worldRectSchema>;
export type ScreenRect = z.infer<typeof screenRectSchema>;
export type Camera = z.infer<typeof cameraSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type NavigationHistoryRecord = z.infer<typeof navigationHistorySchema>;
export type BrowserRecord = z.infer<typeof browserRecordSchema>;
export type BrowserRuntimeState = z.infer<typeof browserRuntimeStateSchema>;
export type BrowserSnapshot = z.infer<typeof browserSnapshotSchema>;
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type LayoutItem = z.infer<typeof layoutItemSchema>;
export type LayoutBatch = z.infer<typeof layoutBatchSchema>;
