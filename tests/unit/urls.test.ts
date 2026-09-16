import { describe, expect, it } from 'vitest';
import { MAX_URL_LENGTH } from '../../src/shared/constants';
import { OmniUserError } from '../../src/shared/errors';
import { InvalidNavigationUrlError, isAllowedNavigationUrl, isPersistableNavigationUrl, normalizeNavigationInput, parseExternalUrl } from '../../src/shared/urls';

describe('navigation URL policy', () => {
  it('normalizes a domain to HTTPS without turning free text into a search', () => {
    expect(normalizeNavigationInput('example.com/docs?q=1')).toBe('https://example.com/docs?q=1');
    expect(() => normalizeNavigationInput('buscar gatitos')).toThrow(InvalidNavigationUrlError);
  });

  it('allows only HTTP, HTTPS, and the exact about:blank URL', () => {
    expect(isAllowedNavigationUrl('https://example.com/')).toBe(true);
    expect(isAllowedNavigationUrl('http://127.0.0.1:8080/')).toBe(true);
    expect(isAllowedNavigationUrl('about:blank')).toBe(true);
    expect(isAllowedNavigationUrl('file:///tmp/secret')).toBe(false);
    expect(isAllowedNavigationUrl('data:text/html,hello')).toBe(false);
    expect(isAllowedNavigationUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedNavigationUrl('about:srcdoc')).toBe(false);
  });

  it('rejects credentials embedded in a URL so they cannot be persisted', () => {
    expect(() => normalizeNavigationInput('https://user:password@example.com/')).toThrow(/credenciales/);
  });

  it('limits external opening to explicitly supported protocols', () => {
    expect(parseExternalUrl('mailto:test@example.com')?.protocol).toBe('mailto:');
    expect(parseExternalUrl('tel:+12025550123')?.protocol).toBe('tel:');
    expect(parseExternalUrl('custom-app://danger')).toBeNull();
  });
});

describe('navigation input hardening', () => {
  it('reports invalid input as a user-facing error instead of an unexpected exception', () => {
    let caught: unknown;
    try {
      normalizeNavigationInput('buscar gatitos');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OmniUserError);
    expect((caught as OmniUserError).code).toBe('invalid-url');
    expect(() => normalizeNavigationInput('   ')).toThrow('Introduce una URL.');
  });

  it('rejects control characters instead of letting the URL parser silently drop them', () => {
    const lineFeed = String.fromCharCode(10);
    const carriageReturn = String.fromCharCode(13);
    const nul = String.fromCharCode(0);
    expect(() => normalizeNavigationInput(`https://exa${lineFeed}mple.com/`)).toThrow(/caracteres de control/);
    expect(() => normalizeNavigationInput(`example.com/${carriageReturn}${lineFeed}Set-Cookie: x=1`)).toThrow(/caracteres de control/);
    expect(() => normalizeNavigationInput(`example.com/${nul}`)).toThrow(/caracteres de control/);
  });

  it('accepts bracketed IPv6, localhost with ports and internationalized domains as HTTPS hosts', () => {
    expect(normalizeNavigationInput('[::1]:3000/app')).toBe('https://[::1]:3000/app');
    expect(normalizeNavigationInput('localhost:8080')).toBe('https://localhost:8080/');
    expect(normalizeNavigationInput('münchen.de')).toBe('https://xn--mnchen-3ya.de/');
    expect(normalizeNavigationInput('example.xn--p1ai')).toBe('https://example.xn--p1ai/');
    expect(normalizeNavigationInput('http://127.0.0.1:9/x')).toBe('http://127.0.0.1:9/x');
  });

  it('blocks non-web schemes typed directly, including data: and file:', () => {
    for (const input of ['file:///etc/passwd', 'data:text/html,<b>x</b>', 'javascript:alert(1)', 'blob:https://example.com/id', 'chrome://settings', 'omnibrowser://app/index.html']) {
      expect(() => normalizeNavigationInput(input), input).toThrow(InvalidNavigationUrlError);
    }
  });

  it('enforces the persisted URL length after normalization', () => {
    const longPath = 'a'.repeat(MAX_URL_LENGTH);
    expect(() => normalizeNavigationInput(`example.com/${longPath}`)).toThrow(`La URL supera el límite de ${MAX_URL_LENGTH} caracteres.`);
    expect(isPersistableNavigationUrl(`https://example.com/${longPath}`)).toBe(false);
    expect(isPersistableNavigationUrl('https://example.com/')).toBe(true);
    expect(isPersistableNavigationUrl('about:blank#x')).toBe(false);
  });
});
