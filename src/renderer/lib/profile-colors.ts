import type { ProfileRecord } from '../../shared/schemas';

const COLORS = ['#1685ff', '#ffbd3f', '#8b5cf6', '#20c997', '#f97367', '#46a7a0'] as const;

export function profileColor(profile: ProfileRecord, index: number): string {
  const normalizedName = profile.name.toLocaleLowerCase();
  if (normalizedName === 'personal') return COLORS[0];
  if (normalizedName === 'trabajo') return COLORS[1];
  if (profile.kind === 'private' || normalizedName === 'private') return COLORS[2];
  return COLORS[index % COLORS.length] ?? COLORS[0];
}
