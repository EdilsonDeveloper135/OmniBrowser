import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';

export const SHELL_SCHEME = 'omnibrowser';
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
  if (shellProtocolInstalled) return `${SHELL_SCHEME}://app/index.html`;
  const rendererEntryPath = fileURLToPath(webpackEntry);
  const rendererOutputRoot = path.dirname(path.dirname(rendererEntryPath));
  protocol.handle(SHELL_SCHEME, (request) => {
    const requestUrl = new URL(request.url);
    const relativePath = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
    const targetPath = relativePath === '/index.html'
      ? rendererEntryPath
      : path.resolve(rendererOutputRoot, `.${relativePath}`);
    if (targetPath !== rendererOutputRoot && !targetPath.startsWith(`${rendererOutputRoot}${path.sep}`)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(targetPath).toString());
  });
  shellProtocolInstalled = true;
  return `${SHELL_SCHEME}://app/index.html`;
}
