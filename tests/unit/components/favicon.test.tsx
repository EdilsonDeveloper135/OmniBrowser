// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Favicon } from '../../../src/renderer/components/Favicon';

afterEach(() => {
  cleanup();
});

describe('Favicon component', () => {
  it('renders img element with encoded URI when faviconKey is provided', () => {
    const { container } = render(
      <Favicon
        browser={{
          url: 'https://github.com/trending',
          runtime: { faviconKey: 'https://github.com/fav.png' }
        }}
        variant="card"
      />
    );

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.className).toBe('browser-favicon');
    expect(img?.getAttribute('src')).toBe(
      'omnibrowser://app/favicon/https%3A%2F%2Fgithub.com%2Ffav.png'
    );
  });

  it('renders fallback letter when faviconKey is null', () => {
    const { container } = render(
      <Favicon
        browser={{
          url: 'https://news.ycombinator.com',
          runtime: { faviconKey: null }
        }}
        variant="card"
      />
    );

    expect(container.querySelector('img')).toBeNull();
    const fallback = screen.getByText('N');
    expect(fallback.className).toBe('favicon-fallback');
    expect(fallback.getAttribute('aria-hidden')).toBe('true');
  });

  it('uses sidebar CSS classes when variant is sidebar', () => {
    const { container, rerender } = render(
      <Favicon
        browser={{
          url: 'https://example.com',
          runtime: { faviconKey: 'key1' }
        }}
        variant="sidebar"
      />
    );

    expect(container.querySelector('img')?.className).toBe('sidebar-favicon');

    rerender(
      <Favicon
        browser={{
          url: 'https://example.com',
          runtime: { faviconKey: null }
        }}
        variant="sidebar"
      />
    );

    expect(screen.getByText('E').className).toBe('sidebar-favicon-fallback');
  });

  it('supports custom className and fallbackClassName overrides', () => {
    const { container, rerender } = render(
      <Favicon
        browser={{
          url: 'https://example.com',
          runtime: { faviconKey: 'custom-key' }
        }}
        className="custom-img-class"
      />
    );

    expect(container.querySelector('img')?.className).toBe('custom-img-class');

    rerender(
      <Favicon
        browser={{
          url: 'https://example.com',
          runtime: { faviconKey: null }
        }}
        fallbackClassName="custom-fallback-class"
      />
    );

    expect(screen.getByText('E').className).toBe('custom-fallback-class');
  });
});
