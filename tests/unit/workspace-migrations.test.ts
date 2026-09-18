import { describe, expect, it } from 'vitest';
import { createInitialWorkspace } from '../../src/main/domain/workspace-model';
import { migrateWorkspace, WorkspaceVersionError } from '../../src/main/persistence/workspace-migrations';
import { WORKSPACE_SCHEMA_VERSION } from '../../src/shared/constants';
import { workspaceFileSchema, type WorkspaceFile } from '../../src/shared/schemas';

function createV1Workspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const initial = createInitialWorkspace();
  const v1: Record<string, unknown> = {
    schemaVersion: 1,
    createdAt: initial.createdAt,
    updatedAt: initial.updatedAt,
    camera: initial.camera,
    selectedBrowserId: initial.selectedBrowserId,
    profiles: initial.profiles.map((p) => ({ ...p })),
    browsers: initial.browsers.map((b) => {
      const copy = { ...b } as Record<string, unknown>;
      delete copy.zoneId;
      delete copy.presentation;
      delete copy.positionLocked;
      delete copy.pin;
      return copy;
    }),
    ...overrides
  };
  delete v1.zones;
  delete v1.stacks;
  delete v1.browserOrder;
  delete v1.preferences;
  return v1;
}

describe('workspace-migrations', () => {
  describe('non-record and version validation', () => {
    it('returns raw value if not a plain record object', () => {
      expect(migrateWorkspace(null)).toBe(null);
      expect(migrateWorkspace(undefined)).toBe(undefined);
      expect(migrateWorkspace('string')).toBe('string');
      expect(migrateWorkspace(123)).toBe(123);
      expect(migrateWorkspace([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it('throws WorkspaceVersionError when schemaVersion is missing or invalid', () => {
      expect(() => migrateWorkspace({})).toThrow(WorkspaceVersionError);
      expect(() => migrateWorkspace({ schemaVersion: '1' })).toThrow('El workspace no declara una versión de esquema reconocible.');
      expect(() => migrateWorkspace({ schemaVersion: 0 })).toThrow('El workspace no declara una versión de esquema reconocible.');
      expect(() => migrateWorkspace({ schemaVersion: -1 })).toThrow('El workspace no declara una versión de esquema reconocible.');
      expect(() => migrateWorkspace({ schemaVersion: 1.5 })).toThrow('El workspace no declara una versión de esquema reconocible.');
      expect(() => migrateWorkspace({ schemaVersion: null })).toThrow('El workspace no declara una versión de esquema reconocible.');
      expect(() => migrateWorkspace({ schemaVersion: Number.NaN })).toThrow('El workspace no declara una versión de esquema reconocible.');
      expect(() => migrateWorkspace({ schemaVersion: Number.POSITIVE_INFINITY })).toThrow('El workspace no declara una versión de esquema reconocible.');
      expect(() => migrateWorkspace({ schemaVersion: Number.NEGATIVE_INFINITY })).toThrow('El workspace no declara una versión de esquema reconocible.');
    });

    it('throws WorkspaceVersionError with futureVersion when schemaVersion is higher than current', () => {
      try {
        migrateWorkspace({ schemaVersion: WORKSPACE_SCHEMA_VERSION + 1 });
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceVersionError);
        const versionError = error as WorkspaceVersionError;
        expect(versionError.futureVersion).toBe(WORKSPACE_SCHEMA_VERSION + 1);
        expect(versionError.message).toContain(`más reciente que el admitido (${WORKSPACE_SCHEMA_VERSION})`);
      }
    });

    it('throws WorkspaceVersionError when a migration step is missing from migrations map', () => {
      expect(() => migrateWorkspace({ schemaVersion: 1 }, {}, 2)).toThrow('No existe una migración desde el esquema 1.');
    });

    it('returns workspace unmodified if it is already at the current version', () => {
      const current = { schemaVersion: WORKSPACE_SCHEMA_VERSION, foo: 'bar' };
      expect(migrateWorkspace(current)).toEqual(current);
    });
  });

  describe('V1 to V2 migration', () => {
    it('successfully migrates a valid V1 workspace to V2 and passes schema validation', () => {
      const v1 = createV1Workspace();
      const migrated = migrateWorkspace(v1) as WorkspaceFile;

      expect(migrated.schemaVersion).toBe(2);
      expect(migrated.zones).toEqual([]);
      expect(migrated.stacks).toEqual([]);
      expect(migrated.preferences).toEqual({ snapEnabled: false, historySwipeEnabled: false });
      expect(migrated.browserOrder).toEqual(migrated.browsers.map((b) => b.id));

      for (const browser of migrated.browsers) {
        expect(browser.zoneId).toBeNull();
        expect(browser.presentation).toBe('normal');
        expect(browser.positionLocked).toBe(false);
        expect(browser.pin).toEqual({ sidebar: false, viewport: null });
      }

      // Validates against official Zod schema
      const parsed = workspaceFileSchema.parse(migrated);
      expect(parsed.schemaVersion).toBe(2);
    });

    it('filters out non-persistent or malformed profiles and their orphaned browsers', () => {
      const v1 = createV1Workspace({
        profiles: [
          { id: 'p-valid', name: 'Valid', color: '#ff0000', kind: 'persistent' },
          { id: 'p-private', name: 'Private', color: '#00ff00', kind: 'private' },
          null,
          'not a profile'
        ],
        browsers: [
          {
            id: 'b-valid',
            profileId: 'p-valid',
            url: 'https://example.com',
            title: 'Valid',
            worldRect: { x: 0, y: 0, width: 800, height: 600 },
            zIndex: 1,
            suspended: false,
            createdAt: new Date().toISOString(),
            history: { entries: [{ url: 'https://example.com', title: 'Valid' }], index: 0 }
          },
          {
            id: 'b-orphaned',
            profileId: 'p-private',
            url: 'https://orphan.com',
            title: 'Orphan',
            worldRect: { x: 100, y: 100, width: 800, height: 600 },
            zIndex: 2,
            suspended: false,
            createdAt: new Date().toISOString(),
            history: { entries: [{ url: 'https://orphan.com', title: 'Orphan' }], index: 0 }
          }
        ],
        selectedBrowserId: 'b-orphaned'
      });

      const migrated = migrateWorkspace(v1) as WorkspaceFile;

      expect(migrated.profiles).toHaveLength(1);
      expect(migrated.profiles[0]?.id).toBe('p-valid');
      expect(migrated.browsers).toHaveLength(1);
      expect(migrated.browsers[0]?.id).toBe('b-valid');
      expect(migrated.browserOrder).toEqual(['b-valid']);
      // Selected browser was orphaned and removed, so selectedBrowserId resets to null
      expect(migrated.selectedBrowserId).toBeNull();
    });

    it('handles corrupted or non-array profiles and browsers gracefully', () => {
      const v1 = createV1Workspace({
        profiles: 'invalid-profiles-type',
        browsers: 'invalid-browsers-type',
        selectedBrowserId: 'b-nonexistent'
      });

      const migrated = migrateWorkspace(v1) as WorkspaceFile;

      expect(migrated.profiles).toEqual([]);
      expect(migrated.browsers).toEqual([]);
      expect(migrated.browserOrder).toEqual([]);
      expect(migrated.selectedBrowserId).toBeNull();
    });

    it('preserves valid selectedBrowserId when present in browserOrder', () => {
      const v1 = createV1Workspace();
      const firstBrowserId = (v1.browsers as Array<{ id: string }>)[0]?.id;
      v1.selectedBrowserId = firstBrowserId;

      const migrated = migrateWorkspace(v1) as WorkspaceFile;
      expect(migrated.selectedBrowserId).toBe(firstBrowserId);
    });
  });
});
