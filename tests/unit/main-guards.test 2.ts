import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveShellRequestPath } from '../../src/main/protocol/shell-paths';
import { ExternalOpenGate } from '../../src/main/security/external-open-gate';

describe('omnibrowser:// shell paths', () => {
  const entry = path.join('/bundle', '.webpack', 'renderer', 'main_window', 'index.html');
  const root = path.join('/bundle', '.webpack', 'renderer');

  it('serves index and packaged assets from the renderer output only', () => {
    expect(resolveShellRequestPath('omnibrowser://app/', entry)).toBe(entry);
    expect(resolveShellRequestPath('omnibrowser://app/index.html', entry)).toBe(entry);
    expect(resolveShellRequestPath('omnibrowser://app/main_window/index.js', entry)).toBe(path.join(root, 'main_window', 'index.js'));
  });

  it('confines dot segments to the renderer output, because the URL parser collapses them first', () => {
    for (const url of ['omnibrowser://app/../../etc/passwd', 'omnibrowser://app/%2e%2e/%2e%2e/etc/passwd']) {
      const resolved = resolveShellRequestPath(url, entry);
      expect(resolved, url).toBe(path.join(root, 'etc', 'passwd'));
      expect(resolved!.startsWith(`${root}${path.sep}`)).toBe(true);
    }
  });

  it('refuses slash-encoded traversal, foreign hosts, malformed escapes and NUL bytes', () => {
    for (const url of [
      'omnibrowser://app/..%2F..%2Fmain%2Findex.js',
      'omnibrowser://evil/index.html',
      'omnibrowser://app/%E0%A4%A',
      'omnibrowser://app/main_window/index.js%00.png',
      'https://app/index.html'
    ]) {
      expect(resolveShellRequestPath(url, entry), url).toBeNull();
    }
  });
});

describe('ExternalOpenGate', () => {
  it('allows one external prompt at a time and cools down the page that triggered it', () => {
    let now = 0;
    const gate = new ExternalOpenGate(5000, () => now);
    expect(gate.tryAcquire(1)).toBe(true);
    expect(gate.tryAcquire(1)).toBe(false);
    expect(gate.tryAcquire(2)).toBe(false);
    gate.release(1);
    expect(gate.tryAcquire(1)).toBe(false);
    expect(gate.tryAcquire(2)).toBe(true);
    gate.release(2);
    now = 5001;
    expect(gate.tryAcquire(1)).toBe(true);
    gate.release(1);
    gate.forget(1);
    expect(gate.tryAcquire(1)).toBe(true);
  });

  it('bounds a page that loops mailto: navigations to a single prompt per cooldown', () => {
    let now = 0;
    const gate = new ExternalOpenGate(5000, () => now);
    let prompts = 0;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      now += 10;
      if (gate.tryAcquire(7)) {
        prompts += 1;
        gate.release(7);
      }
    }
    expect(prompts).toBe(1);
  });
});
