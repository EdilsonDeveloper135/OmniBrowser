import { WORKSPACE_SCHEMA_VERSION } from '../../shared/constants';

export class WorkspaceVersionError extends Error {
  readonly futureVersion: number | null;

  constructor(message: string, futureVersion: number | null = null) {
    super(message);
    this.name = 'WorkspaceVersionError';
    this.futureVersion = futureVersion;
  }
}

type WorkspaceMigration = (workspace: Record<string, unknown>) => Record<string, unknown>;

/**
 * Explicit, ordered upgrades keyed by the schema version they migrate *from*. Every increment of
 * WORKSPACE_SCHEMA_VERSION must add exactly one entry here together with a fixture test of the previous format.
 */
const MIGRATIONS: Readonly<Record<number, WorkspaceMigration>> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Upgrades a parsed workspace to the current schema version before validation. Unknown and future versions are rejected. */
export function migrateWorkspace(raw: unknown, migrations: Readonly<Record<number, WorkspaceMigration>> = MIGRATIONS, currentVersion: number = WORKSPACE_SCHEMA_VERSION): unknown {
  if (!isRecord(raw)) return raw;
  const version = raw.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new WorkspaceVersionError('El workspace no declara una versión de esquema reconocible.');
  }
  if (version > currentVersion) {
    throw new WorkspaceVersionError(`El workspace usa el esquema ${version}, más reciente que el admitido (${currentVersion}).`, version);
  }
  let workspace = raw;
  for (let from = version; from < currentVersion; from += 1) {
    const migration = migrations[from];
    if (!migration) throw new WorkspaceVersionError(`No existe una migración desde el esquema ${from}.`);
    workspace = { ...migration(workspace), schemaVersion: from + 1 };
  }
  return workspace;
}
