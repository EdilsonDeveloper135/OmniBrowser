import { createHash } from 'node:crypto';
import type { Session } from 'electron';

const MAX_FAVICON_BYTES = 256 * 1024;
const MAX_FAVICON_ENTRIES = 256;
const MAX_FAVICON_REDIRECTS = 5;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const ALLOWED_FAVICON_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon'
]);

interface FaviconEntry {
  bytes: Uint8Array;
  contentType: string;
}

const entries = new Map<string, FaviconEntry>();

export async function captureFavicon(profileSession: Session, value: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  try {
    let response: Response | null = null;
    let currentUrl = url;
    for (let redirects = 0; redirects <= MAX_FAVICON_REDIRECTS; redirects += 1) {
      response = await profileSession.fetch(currentUrl.toString(), { redirect: 'manual' });
      if (response.status < 300 || response.status >= 400) break;
      if (redirects === MAX_FAVICON_REDIRECTS) return null;
      const location = response.headers.get('location');
      if (!location) return null;
      currentUrl = new URL(location, currentUrl);
      if (currentUrl.protocol !== 'https:' && currentUrl.protocol !== 'http:') return null;
    }
    if (!response) return null;
    if (!response.ok) return null;
    const finalUrl = new URL(response.url || currentUrl.toString());
    if (finalUrl.protocol !== 'https:' && finalUrl.protocol !== 'http:') return null;
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!ALLOWED_FAVICON_TYPES.has(contentType)) return null;
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FAVICON_BYTES) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_FAVICON_BYTES) return null;
    const bytes = new Uint8Array(buffer);
    const key = createHash('sha256').update(bytes).digest('hex');
    entries.delete(key);
    entries.set(key, { bytes, contentType });
    while (entries.size > MAX_FAVICON_ENTRIES) entries.delete(entries.keys().next().value as string);
    return key;
  } catch {
    return null;
  }
}

export function faviconResponse(key: string): Response | null {
  if (!KEY_PATTERN.test(key)) return null;
  const entry = entries.get(key);
  if (!entry) return null;
  entries.delete(key);
  entries.set(key, entry);
  return new Response(new Blob([entry.bytes.slice().buffer as ArrayBuffer], { type: entry.contentType }), {
    status: 200,
    headers: {
      'Cache-Control': 'private, max-age=3600',
      'Content-Type': entry.contentType,
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export function clearFaviconCache(): void {
  entries.clear();
}
