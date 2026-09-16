const HOST_LIKE_PATTERN = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?::\d{1,5})?(?:[/?#].*)?$/i;
const EXTERNAL_PROTOCOLS = new Set(['mailto:', 'tel:']);

export class InvalidNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNavigationUrlError';
  }
}

export function normalizeNavigationInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new InvalidNavigationUrlError('Introduce una URL.');
  if (trimmed === 'about:blank') return trimmed;

  const candidate = HOST_LIKE_PATTERN.test(trimmed) ? `https://${trimmed}` : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new InvalidNavigationUrlError('La entrada no es una URL válida. OmniBrowser no realiza búsquedas implícitas.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new InvalidNavigationUrlError(`El protocolo ${parsed.protocol || '(vacío)'} no está permitido.`);
  }
  if (parsed.username || parsed.password) {
    throw new InvalidNavigationUrlError('Las URLs con credenciales incrustadas no se guardan por seguridad.');
  }
  return parsed.toString();
}

export function isAllowedNavigationUrl(value: string): boolean {
  if (value === 'about:blank') return true;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function parseExternalUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

export function displayDomain(value: string): string {
  if (value === 'about:blank') return 'Nueva página';
  try {
    return new URL(value).hostname || value;
  } catch {
    return value;
  }
}
