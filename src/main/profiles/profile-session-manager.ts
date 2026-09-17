import { randomUUID } from 'node:crypto';
import { session, type Session } from 'electron';
import type { ProfileRecord } from '../../shared/schemas';
import { configureRestrictedSession, type SecurityNotice } from '../security/security-policy';
import { partitionForProfile } from './partition';

export class ProfileSessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #configuredPartitions = new Set<string>();
  readonly #launchId = randomUUID();
  readonly #notice: SecurityNotice;

  constructor(notice: SecurityNotice) {
    this.#notice = notice;
  }

  partitionFor(profile: ProfileRecord): string {
    return partitionForProfile(profile, this.#launchId);
  }

  get(profile: ProfileRecord): Session {
    const existing = this.#sessions.get(profile.id);
    if (existing) return existing;
    const partition = this.partitionFor(profile);
    const profileSession = session.fromPartition(partition, { cache: true });
    if (!this.#configuredPartitions.has(partition)) {
      configureRestrictedSession(profileSession, this.#notice);
      this.#configuredPartitions.add(partition);
    }
    this.#sessions.set(profile.id, profileSession);
    return profileSession;
  }

  /** Flushes only sessions opened during this run; untouched profiles have nothing pending and must not be created now. */
  async flushPersistent(profiles: readonly ProfileRecord[]): Promise<void> {
    await Promise.all(profiles.filter((profile) => profile.kind === 'persistent').map(async (profile) => {
      const profileSession = this.#sessions.get(profile.id);
      if (!profileSession) return;
      profileSession.flushStorageData();
      await profileSession.cookies.flushStore();
    }));
  }

  async clearPrivate(profiles: readonly ProfileRecord[]): Promise<void> {
    await Promise.all(profiles.filter((profile) => profile.kind === 'private').map(async (profile) => {
      const profileSession = this.#sessions.get(profile.id);
      if (!profileSession) return;
      await Promise.all([profileSession.clearStorageData(), profileSession.clearCache()]);
      this.#sessions.delete(profile.id);
    }));
  }
}
