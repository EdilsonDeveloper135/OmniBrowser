import { fileURLToPath, pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { faviconResponse } from '../browser/favicon-cache';
import { resolveShellRequestPath, SHELL_HOST, SHELL_SCHEME } from './shell-paths';

export { SHELL_SCHEME } from './shell-paths';

// Packaged shell policy. It is sent as a response header and therefore intersects with the <meta> policy, which must stay
// permissive enough for the webpack dev server (`ws:`). Inline styles are limited to attributes for canvas geometry.
export const PRODUCTION_SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-elem 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

let shellProtocolInstalled = false;

export function registerShellScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: SHELL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true
    }
  }]);
}

export async function installShellProtocol(): Promise<string> {
  const webpackEntry = new URL(MAIN_WINDOW_WEBPACK_ENTRY);
  if (webpackEntry.protocol !== 'file:') return MAIN_WINDOW_WEBPACK_ENTRY;
  const shellUrl = `${SHELL_SCHEME}://${SHELL_HOST}/index.html`;
  if (shellProtocolInstalled) return shellUrl;
  const rendererEntryPath = fileURLToPath(webpackEntry);
  protocol.handle(SHELL_SCHEME, async (request) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.host === SHELL_HOST && requestUrl.pathname.startsWith('/favicon/')) {
      return faviconResponse(requestUrl.pathname.slice('/favicon/'.length)) ?? new Response('Not found', { status: 404 });
    }
    const targetPath = resolveShellRequestPath(request.url, rendererEntryPath);
    if (!targetPath) return new Response('Not found', { status: 404 });
    const fileResponse = await net.fetch(pathToFileURL(targetPath).toString());
    const headers = new Headers(fileResponse.headers);
    headers.set('Content-Security-Policy', PRODUCTION_SHELL_CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(fileResponse.body, { status: fileResponse.status, statusText: fileResponse.statusText, headers });
  });
  shellProtocolInstalled = true;
  return shellUrl;
}
