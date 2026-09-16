import { describe, expect, it } from 'vitest';
import { MAX_TITLE_LENGTH, MAX_URL_LENGTH } from '../../src/shared/constants';
import { sanitizeHistory } from '../../src/main/domain/navigation-history';

const entry = (url: string, title = url) => ({ url, title });

describe('sanitizeHistory', () => {
  it('drops blocked and oversized URLs and remaps the active index onto retained entries', () => {
    const history = sanitizeHistory([
      entry('https://a.example/'),
      entry('file:///tmp/secret'),
      entry(`https://long.example/${'x'.repeat(MAX_URL_LENGTH)}`),
      entry('https://b.example/'),
      entry('data:text/html,hi'),
      entry('https://c.example/')
    ], 3);
    expect(history.entries.map((item) => item.url)).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
    expect(history.index).toBe(1);
  });

  it('keeps the nearest newer entry active when the active page itself cannot be persisted', () => {
    const history = sanitizeHistory([entry(`https://long.example/${'x'.repeat(MAX_URL_LENGTH)}`), entry('https://b.example/')], 0);
    expect(history).toEqual({ entries: [entry('https://b.example/')], index: 0 });
  });

  it('truncates titles and never carries page state', () => {
    const raw = [{ url: 'https://a.example/', title: 't'.repeat(MAX_TITLE_LENGTH + 20), pageState: 'secret-form-state' }];
    const history = sanitizeHistory(raw, 0);
    expect(history.entries[0]?.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(JSON.stringify(history)).not.toContain('secret-form-state');
  });

  it('caps the stack to a window that always contains the active entry', () => {
    const entries = Array.from({ length: 30 }, (_, index) => entry(`https://example.com/${index}`));
    const newest = sanitizeHistory(entries, 29, 10);
    expect(newest.entries).toHaveLength(10);
    expect(newest.entries[newest.index]?.url).toBe('https://example.com/29');
    const early = sanitizeHistory(entries, 2, 10);
    expect(early.entries).toHaveLength(10);
    expect(early.entries[early.index]?.url).toBe('https://example.com/2');
    expect(sanitizeHistory(entries, 17, 1)).toEqual({ entries: [entry('https://example.com/17')], index: 0 });
  });

  it('returns an empty history when nothing can be persisted', () => {
    expect(sanitizeHistory([entry('javascript:alert(1)')], 0)).toEqual({ entries: [], index: 0 });
  });
});
