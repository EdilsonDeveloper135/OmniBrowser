import type { Session } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureFavicon, clearFaviconCache, faviconResponse } from '../../src/main/browser/favicon-cache';

function sessionWithFetch(fetch: Session['fetch']): Session {
  return { fetch } as unknown as Session;
}

afterEach(() => clearFaviconCache());

describe('in-memory favicon cache', () => {
  it('accepts only HTTP(S) image responses and exposes an opaque local key', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '4' }
    })) as unknown as Session['fetch'];
    const profileSession = sessionWithFetch(fetch);

    await expect(captureFavicon(profileSession, 'data:image/png;base64,abc')).resolves.toBeNull();
    await expect(captureFavicon(profileSession, 'not a URL')).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    const key = await captureFavicon(profileSession, 'https://example.com/favicon.png');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('example.com');
    expect(fetch).toHaveBeenCalledWith('https://example.com/favicon.png', { redirect: 'manual' });
    const response = faviconResponse(key!);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toBe('image/png');
    expect(response?.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(faviconResponse('https://example.com/favicon.png')).toBeNull();
  });

  it('rejects non-images, active SVG content and declared or actual payloads above the byte limit', async () => {
    const nonImage = sessionWithFetch(vi.fn(async () => new Response('html', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })) as unknown as Session['fetch']);
    await expect(captureFavicon(nonImage, 'https://example.com/favicon')).resolves.toBeNull();

    const svg = sessionWithFetch(vi.fn(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
      status: 200,
      headers: { 'content-type': 'image/svg+xml' }
    })) as unknown as Session['fetch']);
    await expect(captureFavicon(svg, 'https://example.com/favicon.svg')).resolves.toBeNull();

    const declaredTooLarge = sessionWithFetch(vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(256 * 1024 + 1) }
    })) as unknown as Session['fetch']);
    await expect(captureFavicon(declaredTooLarge, 'https://example.com/favicon')).resolves.toBeNull();

    const actualTooLarge = sessionWithFetch(vi.fn(async () => new Response(new Uint8Array(256 * 1024 + 1), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })) as unknown as Session['fetch']);
    await expect(captureFavicon(actualTooLarge, 'https://example.com/favicon')).resolves.toBeNull();
  });

  it('follows only a bounded number of HTTP(S) redirects', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(null, {
      status: 302,
      headers: { location: '/next.png' }
    })) as unknown as Session['fetch'];
    await expect(captureFavicon(sessionWithFetch(fetch), 'https://example.com/favicon')).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(6);

    const unsafeRedirectFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'file:///tmp/favicon.png' }
    })) as unknown as Session['fetch'];
    await expect(captureFavicon(sessionWithFetch(unsafeRedirectFetch), 'https://example.com/favicon')).resolves.toBeNull();
    expect(unsafeRedirectFetch).toHaveBeenCalledTimes(1);
  });
});
