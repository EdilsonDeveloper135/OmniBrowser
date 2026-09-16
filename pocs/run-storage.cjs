const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFixtureServer } = require('./lib/fixture-server.cjs');
const { runElectron } = require('./lib/run-electron.cjs');

const root = path.resolve(__dirname, '..');
const entry = path.join(__dirname, 'storage-main.cjs');

const emptyStorage = (value) => {
  assert.equal(value.persistentCookie, null);
  assert.equal(value.sessionCookie, null);
  assert.equal(value.localStorage, null);
  assert.equal(value.indexedDb, null);
  assert.equal(value.cacheStorage, null);
  assert.deepEqual(value.serviceWorkerScopes, []);
};

const sharedStorage = (value, expectSessionCookie) => {
  assert.equal(value.persistentCookie, 'shared-profile-token');
  assert.equal(value.sessionCookie, expectSessionCookie ? 'shared-profile-token' : null);
  assert.equal(value.localStorage, 'shared-profile-token');
  assert.equal(value.indexedDb, 'shared-profile-token');
  assert.equal(value.cacheStorage, 'shared-profile-token');
  assert.equal(value.serviceWorkerScopes.length, 1);
};

(async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibrowser-storage-poc-'));
  const userData = path.join(workingDirectory, 'user-data');
  const seedOutput = path.join(workingDirectory, 'seed.json');
  const verifyOutput = path.join(workingDirectory, 'verify.json');
  const server = await startFixtureServer();
  try {
    await runElectron(entry, [
      '--phase=seed',
      `--origin=${server.origin}`,
      `--output=${seedOutput}`,
      `--user-data=${userData}`
    ], { cwd: root });
    const seed = JSON.parse(fs.readFileSync(seedOutput, 'utf8'));
    sharedStorage(seed.sharedRead, true);
    emptyStorage(seed.isolatedRead);
    assert.equal(seed.sharedWrite.httpCacheBody, seed.sharedHttpCacheBody);
    assert.notEqual(seed.sharedHttpCacheBody, seed.isolatedHttpCacheBody);
    assert.equal(seed.temporaryRead.localStorage, 'temporary-profile-token');
    assert.equal(seed.temporaryRead.sessionCookie, 'temporary-profile-token');
    assert.equal(seed.temporaryWrite.httpCacheBody, seed.temporaryHttpCacheBody);
    sharedStorage(seed.reassignedBeforeRead, true);
    emptyStorage(seed.reassignedAfterRead);
    sharedStorage(seed.originalProfileAfterReassign, true);
    assert.equal(server.counters.get('/http-cache/shared'), 2);
    assert.equal(server.counters.get('/http-cache/temporary'), 1);
    assert.equal(seed.storagePaths.temporary, null);

    await runElectron(entry, [
      '--phase=verify',
      `--origin=${server.origin}`,
      `--output=${verifyOutput}`,
      `--user-data=${userData}`
    ], { cwd: root });
    const verify = JSON.parse(fs.readFileSync(verifyOutput, 'utf8'));
    sharedStorage(verify.sharedReadA, false);
    sharedStorage(verify.sharedReadB, false);
    emptyStorage(verify.isolatedRead);
    emptyStorage(verify.temporaryReadA);
    emptyStorage(verify.temporaryReadB);
    assert.equal(verify.sharedHttpCacheBody, seed.sharedHttpCacheBody);
    assert.equal(server.counters.get('/http-cache/shared'), 2);
    assert.equal(server.counters.get('/http-cache/temporary'), 2);
    assert.notEqual(verify.temporaryHttpCacheBody, seed.temporaryHttpCacheBody);

    const report = {
      poc: 'profiles-and-storage',
      passed: true,
      electron: require('electron/package.json').version,
      platform: process.platform,
      architecture: process.arch,
      assertions: {
        sharedPartitionRuntime: true,
        isolatedPartitionRuntime: true,
        persistentCookieAfterRestart: true,
        sessionCookieRemovedAfterRestart: true,
        localStorageAfterRestart: true,
        indexedDbAfterRestart: true,
        cacheStorageAfterRestart: true,
        serviceWorkerAfterRestart: true,
        httpCacheSharedAndPersistent: true,
        temporaryPartitionClearedAfterRestart: true,
        profileReassignmentByRecreation: true
      }
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
