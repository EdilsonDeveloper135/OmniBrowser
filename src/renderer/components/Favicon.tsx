import type { BrowserSnapshot } from '../../shared/schemas';
import { displayDomain } from '../../shared/urls';

export interface FaviconProps {
  browser: Pick<BrowserSnapshot, 'url' | 'runtime'>;
  variant?: 'card' | 'sidebar';
  className?: string;
  fallbackClassName?: string;
}

export function Favicon({
  browser,
  variant = 'card',
  className,
  fallbackClassName
}: FaviconProps) {
  const domain = displayDomain(browser.url);
  const imgClass = className ?? (variant === 'sidebar' ? 'sidebar-favicon' : 'browser-favicon');
  const fallbackClass = fallbackClassName ?? (variant === 'sidebar' ? 'sidebar-favicon-fallback' : 'favicon-fallback');

  return browser.runtime.faviconKey ? (
    <img
      alt=""
      className={imgClass}
      src={`omnibrowser://app/favicon/${encodeURIComponent(browser.runtime.faviconKey)}`}
    />
  ) : (
    <span className={fallbackClass} aria-hidden="true">
      {domain.charAt(0).toUpperCase() || '•'}
    </span>
  );
}
