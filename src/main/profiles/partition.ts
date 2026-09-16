import type { ProfileRecord } from '../../shared/schemas';

export function partitionForProfile(profile: ProfileRecord, launchId: string): string {
  return profile.kind === 'persistent'
    ? `persist:omnibrowser-profile-${profile.id}`
    : `omnibrowser-temp-${launchId}-${profile.id}`;
}
