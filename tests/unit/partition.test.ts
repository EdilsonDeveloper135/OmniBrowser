import { describe, expect, it } from 'vitest';
import { partitionForProfile } from '../../src/main/profiles/partition';
import type { ProfileRecord } from '../../src/shared/schemas';

const baseProfile: Omit<ProfileRecord, 'kind'> = {
  id: '6c53840e-68e4-4c65-a767-24924cf02a60',
  name: 'Test',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z'
};

describe('profile partition mapping', () => {
  it('uses a stable persistent Chromium partition for persistent profiles', () => {
    expect(partitionForProfile({ ...baseProfile, kind: 'persistent' }, 'launch-a')).toBe('persist:omnibrowser-profile-6c53840e-68e4-4c65-a767-24924cf02a60');
    expect(partitionForProfile({ ...baseProfile, kind: 'persistent' }, 'launch-b')).toBe('persist:omnibrowser-profile-6c53840e-68e4-4c65-a767-24924cf02a60');
  });

  it('uses a launch-scoped in-memory partition without persist:', () => {
    const partition = partitionForProfile({ ...baseProfile, kind: 'private' }, 'launch-a');
    expect(partition).toBe('omnibrowser-private-launch-a-6c53840e-68e4-4c65-a767-24924cf02a60');
    expect(partition.startsWith('persist:')).toBe(false);
  });
});
