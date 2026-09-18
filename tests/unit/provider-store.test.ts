import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProviderDecryptionError,
  ProviderEncryptionUnavailableError,
  ProviderStore,
  normalizeProviderBaseUrl,
  type SafeStorageAdapter
} from '../../src/main/agents/provider-store';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omnibrowser-provider-store-test-'));
  directories.push(directory);
  return directory;
}

/** Fails the test on any keychain access: the macOS password prompt must not appear on these paths. */
const untouchableKeychain: SafeStorageAdapter = {
  isEncryptionAvailable: () => { throw new Error('The keychain must not be used here.'); },
  encryptString: () => { throw new Error('The keychain must not be used here.'); },
  decryptString: () => { throw new Error('The keychain must not be used here.'); }
};

class FakeSafeStorage implements SafeStorageAdapter {
  constructor(readonly available = true) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(plainText: string): Buffer {
    if (!this.available) throw new Error('unavailable');
    return Buffer.from([...Buffer.from(plainText, 'utf8')].map((byte) => byte ^ 0xa5));
  }

  decryptString(encrypted: Buffer): string {
    if (!this.available) throw new Error('unavailable');
    return Buffer.from([...encrypted].map((byte) => byte ^ 0xa5)).toString('utf8');
  }
}

describe('ProviderStore', () => {
  it('encrypts the API key, restores it after restart, and never returns it publicly', async () => {
    const userData = await temporaryDirectory();
    const safeStorage = new FakeSafeStorage();
    const store = new ProviderStore(userData, safeStorage, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const publicConfig = await store.save({
      baseUrl: 'https://api.example.com/v1/',
      model: 'example-model',
      apiKey: 'provider-key-that-must-stay-secret'
    });

    expect(publicConfig).toEqual({
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      hasApiKey: true,
      keyStorage: 'encrypted',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    expect(publicConfig).not.toHaveProperty('apiKey');
    expect(publicConfig).not.toHaveProperty('encryptedApiKey');
    const source = await readFile(store.providerPath, 'utf8');
    expect(source).not.toContain('provider-key-that-must-stay-secret');
    expect(source).not.toMatch(/"apiKey"/);
    expect((await lstat(store.providerPath)).mode & 0o777).toBe(0o600);

    const reopened = new ProviderStore(userData, safeStorage);
    expect(await reopened.getPublic()).toEqual(publicConfig);
    expect(await reopened.revealApiKey()).toBe('provider-key-that-must-stay-secret');
  });

  it('fails closed without system encryption and writes no provider file', async () => {
    const userData = await temporaryDirectory();
    const store = new ProviderStore(userData, new FakeSafeStorage(false));
    await expect(store.save({ baseUrl: 'https://api.example.com/v1', model: 'model', apiKey: 'secret' }))
      .rejects.toBeInstanceOf(ProviderEncryptionUnavailableError);
    await expect(lstat(store.providerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.getPublic()).toBeNull();
  });

  it('loads a saved provider without the keychain and reports a refused keychain only when the key is needed', async () => {
    const userData = await temporaryDirectory();
    await new ProviderStore(userData, new FakeSafeStorage()).save({ baseUrl: 'https://api.example.com/v1', model: 'model', apiKey: 'secret' });
    const source = await readFile(path.join(userData, 'agent-provider.json'), 'utf8');

    const launched = new ProviderStore(userData, untouchableKeychain);
    const loaded = await launched.initialize();
    expect(loaded.warning).toBeUndefined();
    expect(loaded.provider).toMatchObject({ hasApiKey: true, keyStorage: 'encrypted' });

    // A refusal is not corruption: the file stays as it was, for a later session that is allowed to read it.
    await expect(new ProviderStore(userData, new FakeSafeStorage(false)).revealApiKey()).rejects.toBeInstanceOf(ProviderEncryptionUnavailableError);
    const rotated: SafeStorageAdapter = { isEncryptionAvailable: () => true, encryptString: () => Buffer.alloc(0), decryptString: () => { throw new Error('bad key'); } };
    await expect(new ProviderStore(userData, rotated).revealApiKey()).rejects.toBeInstanceOf(ProviderDecryptionError);
    expect(await readFile(path.join(userData, 'agent-provider.json'), 'utf8')).toBe(source);
    expect((await readdir(userData)).filter((name) => name.includes('corrupt'))).toEqual([]);
  });

  it('keeps a key for the session only, without the keychain, and remembers the endpoint', async () => {
    const userData = await temporaryDirectory();
    const store = new ProviderStore(userData, untouchableKeychain);
    const saved = await store.save({ baseUrl: 'https://api.example.com/v1', model: 'model', apiKey: 'session-secret' }, { rememberKey: false });
    expect(saved).toMatchObject({ hasApiKey: true, keyStorage: 'session' });
    expect(await store.revealApiKey()).toBe('session-secret');
    const source = await readFile(store.providerPath, 'utf8');
    expect(source).not.toContain('session-secret');
    expect(source).not.toContain('encryptedApiKey');

    const restarted = new ProviderStore(userData, untouchableKeychain);
    expect(await restarted.getPublic()).toMatchObject({ baseUrl: 'https://api.example.com/v1', model: 'model', hasApiKey: false, keyStorage: null });
    expect(await restarted.revealApiKey()).toBeNull();

    // Remembering a key later encrypts it and replaces the session key.
    const keychain = new FakeSafeStorage();
    const remembered = new ProviderStore(userData, keychain);
    await remembered.save({ baseUrl: 'https://api.example.com/v1', model: 'model', apiKey: 'session-secret' }, { rememberKey: false });
    expect(await remembered.save({ baseUrl: 'https://api.example.com/v1', model: 'model', apiKey: 'kept-secret' })).toMatchObject({ keyStorage: 'encrypted' });
    expect(await remembered.revealApiKey()).toBe('kept-secret');
    expect(await new ProviderStore(userData, keychain).revealApiKey()).toBe('kept-secret');
  });

  it('accepts HTTP only on loopback and rejects credentials, queries, and fragments', () => {
    expect(normalizeProviderBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080/v1');
    expect(normalizeProviderBaseUrl('http://[::1]:8080/v1')).toBe('http://[::1]:8080/v1');
    expect(() => normalizeProviderBaseUrl('http://api.example.com/v1')).toThrow(/HTTP solo está permitido/);
    expect(() => normalizeProviderBaseUrl('https://user:password@api.example.com/v1')).toThrow(/credenciales/);
    expect(() => normalizeProviderBaseUrl('https://api.example.com/v1?tenant=a')).toThrow(/query/);
    expect(() => normalizeProviderBaseUrl('https://api.example.com/v1#fragment')).toThrow(/fragmento/);
    expect(() => normalizeProviderBaseUrl('file:///tmp/socket')).toThrow(/http o https/);
  });

  it('preserves a corrupt provider file and returns an unconfigured state', async () => {
    const userData = await temporaryDirectory();
    const providerPath = path.join(userData, 'agent-provider.json');
    await writeFile(providerPath, '{ invalid', { encoding: 'utf8', mode: 0o600 });
    const store = new ProviderStore(userData, new FakeSafeStorage(), { now: () => new Date('2026-02-03T04:05:06.000Z') });
    const loaded = await store.initialize();
    expect(loaded.provider).toBeNull();
    expect(loaded.warning).toMatch(/no era válido/);
    const preserved = (await readdir(userData)).find((name) => name.startsWith('agent-provider.corrupt-2026-02-03T04-05-06-000Z-'));
    expect(preserved).toBeDefined();
    expect(await readFile(path.join(userData, preserved!), 'utf8')).toBe('{ invalid');
  });

  it('clears only the encrypted configuration', async () => {
    const userData = await temporaryDirectory();
    const store = new ProviderStore(userData, new FakeSafeStorage());
    await store.save({ baseUrl: 'https://api.example.com/v1', model: 'model', apiKey: 'secret' });
    await writeFile(path.join(userData, 'unrelated.txt'), 'keep me', 'utf8');
    expect(await store.clear()).toBe(true);
    expect(await store.getPublic()).toBeNull();
    expect(await store.revealApiKey()).toBeNull();
    await expect(lstat(store.providerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(userData, 'unrelated.txt'), 'utf8')).toBe('keep me');
  });
});
