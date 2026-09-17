import path from 'node:path';

export const SHELL_SCHEME = 'omnibrowser';
export const SHELL_HOST = 'app';

/** Maps an `omnibrowser://app/...` request to a file inside the packaged renderer output, or null if it must be refused. */
export function resolveShellRequestPath(requestUrl: string, rendererEntryPath: string): string | null {
  const url = new URL(requestUrl);
  if (url.protocol !== `${SHELL_SCHEME}:` || url.host !== SHELL_HOST) return null;
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  } catch {
    return null;
  }
  if (relativePath.includes('\0')) return null;
  const rendererOutputRoot = path.dirname(path.dirname(rendererEntryPath));
  const targetPath = relativePath === '/index.html' ? rendererEntryPath : path.resolve(rendererOutputRoot, `.${relativePath}`);
  if (targetPath !== rendererOutputRoot && !targetPath.startsWith(`${rendererOutputRoot}${path.sep}`)) return null;
  return targetPath;
}
