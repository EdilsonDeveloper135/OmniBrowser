import { MAX_HISTORY_ENTRIES, MAX_TITLE_LENGTH } from '../../shared/constants';
import type { NavigationHistoryRecord } from '../../shared/schemas';
import { isPersistableNavigationUrl } from '../../shared/urls';

export interface RawHistoryEntry {
  url: string;
  title: string;
}

/** First index of a window of at most `maxEntries` items that always contains `activeIndex` and prefers newer entries. */
function windowStart(length: number, activeIndex: number, maxEntries: number): number {
  if (length <= maxEntries) return 0;
  return Math.max(0, Math.min(activeIndex, length - maxEntries));
}

/**
 * Keeps only entries that can be persisted and restored (allowed scheme, bounded URL), truncates titles and remaps the
 * active index onto the retained entries. Chromium page state is never part of the result.
 */
export function sanitizeHistory(entries: readonly RawHistoryEntry[], activeIndex: number, maxEntries = MAX_HISTORY_ENTRIES): NavigationHistoryRecord {
  const retained: NavigationHistoryRecord['entries'] = [];
  let retainedActiveIndex = -1;
  let firstRetainedAfterActive = -1;
  entries.forEach((entry, index) => {
    if (!isPersistableNavigationUrl(entry.url)) return;
    retained.push({ url: entry.url, title: entry.title.slice(0, MAX_TITLE_LENGTH) });
    if (index <= activeIndex) retainedActiveIndex = retained.length - 1;
    else if (firstRetainedAfterActive === -1) firstRetainedAfterActive = retained.length - 1;
  });
  if (retained.length === 0) return { entries: [], index: 0 };
  const active = retainedActiveIndex >= 0 ? retainedActiveIndex : Math.max(0, firstRetainedAfterActive);
  const start = windowStart(retained.length, active, Math.max(1, maxEntries));
  const windowed = retained.slice(start, start + Math.max(1, maxEntries));
  return { entries: windowed, index: Math.min(active - start, windowed.length - 1) };
}
