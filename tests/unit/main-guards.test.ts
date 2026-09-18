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

  it('automatically prunes expired entries to prevent memory leaks', () => {
    let now = 0;
    const gate = new ExternalOpenGate(1000, () => now);

    gate.tryAcquire(101);
    gate.release(101);
    gate.tryAcquire(102);
    gate.release(102);

    expect(gate.activeCooldownCount).toBe(2);

    now = 500;
    gate.tryAcquire(103);
    gate.release(103);
    expect(gate.activeCooldownCount).toBe(3);

    now = 1001;
    // Entries 101 and 102 are expired, 103 (expires at 1500) remains
    expect(gate.activeCooldownCount).toBe(1);

    now = 2000;
    expect(gate.activeCooldownCount).toBe(0);
  });

  it('does not store cooldowns when cooldownMs is zero or negative', () => {
    const now = 100;
    const gate = new ExternalOpenGate(0, () => now);
    expect(gate.tryAcquire(50)).toBe(true);
    gate.release(50);
    expect(gate.activeCooldownCount).toBe(0);
    expect(gate.tryAcquire(50)).toBe(true);
    gate.release(50);
  });

  it('bounds maximum stored cooldowns to MAX_COOLDOWNS by evicting oldest entries', () => {
    const now = 1000;
    const gate = new ExternalOpenGate(60_000, () => now);

    for (let i = 1; i <= ExternalOpenGate.MAX_COOLDOWNS + 10; i++) {
      gate.tryAcquire(i);
      gate.release(i);
    }

    expect(gate.activeCooldownCount).toBe(ExternalOpenGate.MAX_COOLDOWNS);
    // Oldest entry (1) was evicted, so it can be acquired immediately
    expect(gate.tryAcquire(1)).toBe(true);
  });
});
