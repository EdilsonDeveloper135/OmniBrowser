import { describe, expect, it } from 'vitest';
import { InvalidNavigationUrlError, isAllowedNavigationUrl, normalizeNavigationInput, parseExternalUrl } from '../../src/shared/urls';

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
