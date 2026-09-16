const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, session } = require('electron');

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  if (!value) throw new Error(`Missing required ${prefix}<value> argument.`);
  return value.slice(prefix.length);
}

const phase = argument('phase');
const origin = argument('origin');
const output = argument('output');
const userData = argument('user-data');
app.setPath('userData', userData);

const secureWebPreferences = (profileSession) => ({
  session: profileSession,
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  backgroundThrottling: true
});

async function createView(window, profileSession, x) {
  const view = new WebContentsView({ webPreferences: secureWebPreferences(profileSession) });
  window.contentView.addChildView(view);
  view.setBounds({ x, y: 0, width: 320, height: 240 });
  await view.webContents.loadURL(`${origin}/storage.html`);
  return view;
}

async function execute(view, source) {
  return view.webContents.executeJavaScript(source, true);
}

async function closeAll(window, views) {
  for (const view of views) {
    try { window.contentView.removeChildView(view); } catch {}
    try {
      const contents = view.webContents;
      if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    } catch {}
  }
  if (!window.isDestroyed()) window.destroy();
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: secureWebPreferences(session.defaultSession) });
  const shared = session.fromPartition('persist:omnibrowser-profile-poc-shared');
  const isolated = session.fromPartition('persist:omnibrowser-profile-poc-isolated');
  const temporary = session.fromPartition('omnibrowser-temp-poc');
  const views = [];

  try {
    const sharedA = await createView(window, shared, 0); views.push(sharedA);
    const sharedB = await createView(window, shared, 330); views.push(sharedB);
    const isolatedC = await createView(window, isolated, 660); views.push(isolatedC);
    const temporaryA = await createView(window, temporary, 0); views.push(temporaryA);
    const temporaryB = await createView(window, temporary, 330); views.push(temporaryB);

    let result;
    if (phase === 'seed') {
      const sharedToken = 'shared-profile-token';
      const temporaryToken = 'temporary-profile-token';
      const sharedWrite = await execute(sharedA, `window.__storagePoc.write(${JSON.stringify(sharedToken)}, '/http-cache/shared')`);
      const sharedRead = await execute(sharedB, 'window.__storagePoc.read()');
      const sharedHttpCacheBody = await execute(sharedB, "window.__storagePoc.fetchHttpCache('/http-cache/shared')");
      const isolatedRead = await execute(isolatedC, 'window.__storagePoc.read()');
      const isolatedHttpCacheBody = await execute(isolatedC, "window.__storagePoc.fetchHttpCache('/http-cache/shared')");
      const temporaryWrite = await execute(temporaryA, `window.__storagePoc.write(${JSON.stringify(temporaryToken)}, '/http-cache/temporary')`);
      const temporaryRead = await execute(temporaryB, 'window.__storagePoc.read()');
      const temporaryHttpCacheBody = await execute(temporaryB, "window.__storagePoc.fetchHttpCache('/http-cache/temporary')");
      const reassignedBefore = await createView(window, shared, 660); views.push(reassignedBefore);
      const reassignedBeforeRead = await execute(reassignedBefore, 'window.__storagePoc.read()');
      window.contentView.removeChildView(reassignedBefore);
      reassignedBefore.webContents.close({ waitForBeforeUnload: false });
      const reassignedAfter = await createView(window, isolated, 660); views.push(reassignedAfter);
      const reassignedAfterRead = await execute(reassignedAfter, 'window.__storagePoc.read()');
      const originalProfileAfterReassign = await execute(sharedB, 'window.__storagePoc.read()');
      await shared.flushStorageData();
      await shared.cookies.flushStore();
      await isolated.flushStorageData();
      await isolated.cookies.flushStore();
      result = {
        phase,
        sharedWrite,
        sharedRead,
        sharedHttpCacheBody,
        isolatedRead,
        isolatedHttpCacheBody,
        temporaryWrite,
        temporaryRead,
        temporaryHttpCacheBody,
        reassignedBeforeRead,
        reassignedAfterRead,
        originalProfileAfterReassign,
        storagePaths: {
          shared: shared.storagePath,
          isolated: isolated.storagePath,
          temporary: temporary.storagePath
        }
      };
    } else if (phase === 'verify') {
      result = {
        phase,
        sharedReadA: await execute(sharedA, 'window.__storagePoc.read()'),
        sharedReadB: await execute(sharedB, 'window.__storagePoc.read()'),
        sharedHttpCacheBody: await execute(sharedA, "window.__storagePoc.fetchHttpCache('/http-cache/shared')"),
        isolatedRead: await execute(isolatedC, 'window.__storagePoc.read()'),
        temporaryReadA: await execute(temporaryA, 'window.__storagePoc.read()'),
        temporaryReadB: await execute(temporaryB, 'window.__storagePoc.read()'),
        temporaryHttpCacheBody: await execute(temporaryA, "window.__storagePoc.fetchHttpCache('/http-cache/temporary')")
      };
    } else {
      throw new Error(`Unknown storage POC phase: ${phase}`);
    }

    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    await closeAll(window, views);
    app.exit(0);
  } catch (error) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ phase, error: error instanceof Error ? error.stack : String(error) }, null, 2));
    await closeAll(window, views);
    app.exit(1);
  }
});
